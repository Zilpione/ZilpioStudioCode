/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { startRpc } = require('./rpc.js');
const { writeJson } = require('./profiles.js');
const { withAccountRpc } = require('./account-auth.js');

async function readAuthentication(binary, profile) {
	return withAccountRpc(binary, profile, async (worker, home) => {
		await worker.initialize();
		const status = await worker.request('getAuthStatus', { includeToken: true, refreshToken: true });
		if (!status.authToken) { throw new Error('Collega un account a questo profilo prima di usarlo.'); }
		if (status.authMethod === 'apikey') { return { type: 'apiKey', apiKey: status.authToken }; }
		if (status.authMethod !== 'chatgpt' && status.authMethod !== 'chatgptAuthTokens') { throw new Error('Tipo di autenticazione non supportato.'); }
		let accountId;
		try {
			const claims = JSON.parse(Buffer.from(status.authToken.split('.')[1], 'base64url').toString('utf8'));
			accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
		} catch { /* The file fallback also supports older account tokens. */ }
		if (!accountId) {
			try { accountId = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')).tokens?.account_id; }
			catch { /* Keyring-only accounts must carry their account id in the JWT. */ }
		}
		if (typeof accountId !== 'string' || !accountId) { throw new Error('Identificativo account non disponibile. Collega nuovamente il profilo.'); }
		return { type: 'chatgptAuthTokens', accessToken: status.authToken, chatgptAccountId: accountId };
	});
}

class CodexBackend {
	constructor(root, binary, notify, authenticate = readAuthentication) {
		this.root = root;
		this.binary = binary;
		this.notify = notify;
		this.authenticate = authenticate;
		this.busy = false;
		this.switching = false;
		this.threadId = undefined;
		this.metaQueue = Promise.resolve();
	}
	assertIdle() {
		if (this.busy || this.switching) { throw new Error('Codex sta eseguendo un turn: attendi la fine o interrompilo prima di cambiare profilo.'); }
	}
	async start() {
		if (this.rpc && !this.rpc.closed) { return; }
		if (this.starting) { return this.starting; }
		this.starting = this.startRuntime().finally(() => { this.starting = undefined; });
		return this.starting;
	}
	async startRuntime() {
		const home = path.join(this.root, 'runtime');
		await fs.mkdir(home, { recursive: true });
		this.lockFile = path.join(this.root, 'runtime.lock');
		if (!this.lock) {
			try { this.lock = await fs.open(this.lockFile, 'wx', 0o600); }
			catch (error) {
				if (error.code !== 'EEXIST') { throw error; }
				let pid;
				try { pid = Number(await fs.readFile(this.lockFile, 'utf8')); process.kill(pid, 0); }
				catch (error) {
					if (error.code === 'ESRCH') { await fs.unlink(this.lockFile); this.lock = await fs.open(this.lockFile, 'wx', 0o600); }
					else { throw new Error('Codex Zilpio è già aperto in un’altra finestra. Chiudilo prima di continuare.'); }
				}
				if (!this.lock) { throw new Error('Codex Zilpio è già aperto in un’altra finestra.'); }
			}
			await this.lock.writeFile(String(process.pid));
		}
		const rpc = startRpc(await this.binary(), home, true);
		this.rpc = rpc;
		rpc.handleRequest = (method, params) => this.handleRequest(method, params);
		rpc.on('notification', (method, params) => {
			if (method === 'turn/completed' && params.threadId === this.threadId) { this.busy = false; this.notify({ type: 'busy', busy: false }); }
			this.notify({ type: 'event', method, params });
		});
		rpc.on('closed', reason => { this.busy = false; this.authenticated = false; this.notify({ type: 'error', message: reason }); this.notify({ type: 'busy', busy: false }); });
		try { await rpc.initialize(); }
		catch (error) { rpc.dispose(); await this.releaseLock(); throw error; }
		this.authenticated = false;
		this.needsResume = Boolean(this.threadId);
		try { this.meta = JSON.parse(await fs.readFile(path.join(this.root, 'history.json'), 'utf8')); }
		catch (error) { if (error.code !== 'ENOENT') { rpc.dispose(); await this.releaseLock(); throw error; } this.meta = { version: 1, chats: [] }; }
		if (this.meta.version !== 1 || !Array.isArray(this.meta.chats)) { rpc.dispose(); await this.releaseLock(); throw new Error('Registro storico non valido.'); }
	}
	async handleRequest(method, params) {
		if (method === 'account/chatgptAuthTokens/refresh') {
			if (!this.profile) { throw new Error('Nessun profilo attivo.'); }
			const credentials = await this.authenticate(await this.binary(), this.profile);
			if (credentials.type !== 'chatgptAuthTokens') { throw new Error('Il profilo richiede un account ChatGPT.'); }
			if (params.previousAccountId && params.previousAccountId !== credentials.chatgptAccountId) { throw new Error('Account cambiato nel profilo: selezionalo nuovamente.'); }
			return { accessToken: credentials.accessToken, chatgptAccountId: credentials.chatgptAccountId, chatgptPlanType: credentials.chatgptPlanType ?? null };
		}
		return this.approve?.(method, params);
	}
	async switchProfile(profile) {
		this.assertIdle();
		this.switching = true;
		try {
			await this.start();
			const credentials = await this.authenticate(await this.binary(), profile);
			await this.rpc.request('account/login/start', credentials);
			this.profile = profile;
			this.authenticated = true;
			this.notify({ type: 'profile', name: profile.name, id: profile.id });
		} finally { this.switching = false; }
	}
	async saveMeta() {
		const snapshot = structuredClone(this.meta);
		const result = this.metaQueue.then(() => writeJson(path.join(this.root, 'history.json'), snapshot));
		this.metaQueue = result.catch(() => {});
		await result;
	}
	async send(text, cwd, profile) {
		this.assertIdle();
		if (!this.authenticated || this.profile?.id !== profile.id || this.profile?.home !== profile.home || this.profile?.provider !== profile.provider) { await this.switchProfile(profile); }
		this.busy = true;
		this.notify({ type: 'busy', busy: true });
		let turnStarted = false;
		try {
			if (this.needsResume) { await this.rpc.request('thread/resume', { threadId: this.threadId, modelProvider: 'openai' }); this.needsResume = false; }
			if (!this.threadId) {
				const result = await this.rpc.request('thread/start', { cwd, modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: 'workspace-write', persistExtendedHistory: true });
				this.threadId = result.thread.id;
				this.meta.chats.unshift({ id: this.threadId, title: text.slice(0, 80), cwd, createdAt: Date.now(), turnProfiles: [] });
				await this.saveMeta();
			}
			const result = await this.rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }] });
			turnStarted = true;
			const chat = this.meta.chats.find(c => c.id === this.threadId);
			chat.turnProfiles.push({ turnId: result.turn.id, profileId: profile.id, profileName: profile.name, at: Date.now() });
			await this.saveMeta();
		} catch (error) { if (!turnStarted) { this.busy = false; this.notify({ type: 'busy', busy: false }); } throw error; }
	}
	async openThread(id) {
		this.assertIdle();
		await this.start();
		if (!this.meta.chats.some(c => c.id === id)) { throw new Error('Chat non presente nello storico Zilpio.'); }
		const result = await this.rpc.request('thread/resume', { threadId: id, modelProvider: 'openai' });
		this.threadId = id;
		this.needsResume = false;
		return { thread: result.thread, profiles: this.meta.chats.find(c => c.id === id).turnProfiles };
	}
	async history() { await this.start(); return this.meta.chats; }
	newChat() { this.assertIdle(); this.threadId = undefined; this.needsResume = false; }
	async interrupt() {
		if (!this.busy || !this.threadId) { return; }
		const result = await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true });
		const turn = result.thread.turns.findLast(t => t.status === 'inProgress');
		if (turn) { await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: turn.id }); }
	}
	async releaseLock() {
		if (this.lock) { await this.lock.close(); this.lock = undefined; await fs.unlink(this.lockFile); }
	}
	async dispose() { this.rpc?.dispose(); await this.metaQueue; await this.releaseLock(); }
}
module.exports = { CodexBackend, readAuthentication };
