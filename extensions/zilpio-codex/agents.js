/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomInt } = require('node:crypto');
const { ProfileStore, writeJson } = require('./profiles.js');
const colors = ['#8d9aff', '#61c8a5', '#e4b65f', '#ee93ba', '#76b8ed', '#c4a0ed', '#ec9a70'];
const names = ['Elio', 'Orione', 'Vega', 'Lira', 'Atlas', 'AgentOne', 'Sirio', 'Iris'];
const homeKey = home => process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home);
const nameKey = name => name.normalize('NFKC').toLowerCase();
const routingInstructions = 'ZilpioAgents are existing, persistent chat conversations. When the user refers to a named agent (for example @AgentOne or @AgentTwo), first call mcp__zilpio_agents.list_agents to resolve its stable ID. Send the request with mcp__zilpio_agents.send_message to that ID. Never create, spawn or rename a subagent as a substitute for a named ZilpioAgent, including when a delegation skill suggests spawning. If an agent is absent, report it instead of impersonating it. Delivered work executes in the recipient chat with its existing history. send_message waits until the recipient finishes and returns its final result directly to the calling chat; keep your turn open while it runs, then use that result to answer the user. Do not poll, resend, or create a duplicate reply. Use ordinary subagents only for separately requested work that does not address a ZilpioAgent.';
function validName(name) {
	if (typeof name !== 'string' || !/^[\p{L}][\p{L}\p{N}_-]{0,39}$/u.test(name)) { throw new Error('Nome non valido: usa fino a 40 lettere, numeri, _ o -, senza spazi.'); }
	return name.normalize('NFKC');
}
function validColor(color) {
	if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) { throw new Error('Colore non valido.'); }
	return color.toLowerCase();
}
class AgentStore extends ProfileStore {
	constructor(root) { super(root, [], { fileName: 'agents.json' }); }
	async suggest() {
		const db = await this.load(), base = names[randomInt(names.length)]; let name = base;
		for (let suffix = 2; db.reservedNames.includes(nameKey(name)); suffix++) { name = `${base}${suffix}`; }
		return { name, color: colors[randomInt(colors.length)] };
	}
	async load() {
		let db;
		try { db = JSON.parse(await fs.readFile(this.file, 'utf8')); }
		catch (error) { if (error.code === 'ENOENT') { return { version: 1, agents: [], reservedNames: [] }; } throw error; }
		if (db?.version !== 1 || !Array.isArray(db.agents) || !Array.isArray(db.reservedNames) || db.reservedNames.some(n => typeof n !== 'string')) { throw new Error('Registro ZilpioAgents non valido.'); }
		const ids = new Set(), uniqueNames = new Set(), threads = new Set();
		for (const agent of db.agents) {
			validName(agent.name); validColor(agent.color);
			if (agent.project !== undefined && (typeof agent.project !== 'string' || !path.isAbsolute(agent.project))) { throw new Error('Progetto agente non valido.'); }
			if (typeof agent.id !== 'string' || !agent.id || typeof agent.threadId !== 'string' || !agent.threadId || typeof agent.home !== 'string' || !path.isAbsolute(agent.home)) { throw new Error('Identità agente non valida.'); }
			const key = `${homeKey(agent.home)}:${agent.threadId}`;
			if (ids.has(agent.id) || uniqueNames.has(nameKey(agent.name)) || threads.has(key)) { throw new Error('Registro agenti con duplicati.'); }
			ids.add(agent.id); uniqueNames.add(nameKey(agent.name)); threads.add(key);
		}
		return db;
	}
	create({ threadId, home, name, color, originalTitle, project }) {
		return this.serialize(async () => {
			if (typeof threadId !== 'string' || !threadId || threadId.length > 200 || typeof home !== 'string' || !path.isAbsolute(home)) { throw new Error('Chat o environment non valido.'); }
			if (project !== undefined && (typeof project !== 'string' || !path.isAbsolute(project))) { throw new Error('Progetto agente non valido.'); }
			const db = await this.load();
			if (db.agents.some(a => a.threadId === threadId && homeKey(a.home) === homeKey(home))) { throw new Error('Questa chat è già un agente.'); }
			if (name === undefined || name === '') {
				const base = names[randomInt(names.length)]; name = base;
				for (let suffix = 2; db.reservedNames.includes(nameKey(name)); suffix++) { name = `${base}${suffix}`; }
			}
			name = validName(name);
			if (db.reservedNames.includes(nameKey(name)) || db.agents.some(a => nameKey(a.name) === nameKey(name))) { throw new Error('Nome già assegnato o ritirato. Scegli un altro nome.'); }
			const agent = { id: randomUUID(), threadId, home: path.resolve(home), name, color: validColor(color ?? colors[randomInt(colors.length)]), ...(project ? { project: path.resolve(project) } : {}), ...(typeof originalTitle === 'string' ? { originalTitle: originalTitle.slice(0, 500) } : {}) };
			db.agents.push(agent); db.reservedNames.push(nameKey(name)); await writeJson(this.file, db); return agent;
		});
	}
	edit(id, changes) {
		return this.serialize(async () => {
			const db = await this.load(), agent = db.agents.find(a => a.id === id);
			if (!agent) { throw new Error('Agente non più presente.'); }
			if (changes.name !== undefined) {
				const name = validName(changes.name);
				if (nameKey(name) !== nameKey(agent.name)) {
					if (db.reservedNames.includes(nameKey(name))) { throw new Error('Nome già assegnato o ritirato.'); }
					db.reservedNames.push(nameKey(name));
				}
				agent.name = name;
			}
			if (changes.color !== undefined) { agent.color = validColor(changes.color); }
			await writeJson(this.file, db); return agent;
		});
	}
	remove(id) {
		return this.serialize(async () => {
			const db = await this.load(); db.agents = db.agents.filter(a => a.id !== id); await writeJson(this.file, db);
		});
	}
	assignProject(id, project) {
		return this.serialize(async () => {
			const db = await this.load(), agent = db.agents.find(a => a.id === id);
			if (agent && !agent.project) { agent.project = path.resolve(project); await writeJson(this.file, db); }
		});
	}
}
class AgentRouter {
	constructor({ store, home, projects, request, busy = () => false, changed = () => {}, prepare = async p => p }) {
		Object.assign(this, { store, home, projects, request, busy, changed, prepare });
		this.queues = new Map(); this.running = new Map(); this.waiting = new Map(); this.draining = new Map(); this.disposed = false; this.generation = 0;
	}
	async list() {
		const db = await this.store.load();
		if (this.projects) {
			for (const agent of db.agents.filter(a => !a.project && homeKey(a.home) === homeKey(this.home))) {
				let cwd;
				try { cwd = (await this.request('thread/read', { threadId: agent.threadId, includeTurns: false })).thread?.cwd; } catch { continue; }
				if (typeof cwd === 'string' && path.isAbsolute(cwd)) { agent.project = path.resolve(cwd); await this.store.assignProject(agent.id, agent.project); }
			}
		}
		return db.agents.filter(a => !this.projects || (a.project && this.projects.some(p => homeKey(p) === homeKey(a.project)) && homeKey(a.home) === homeKey(this.home)))
			.map(a => {
				const waitingFor = [...(this.waiting.get(a.threadId) || [])].map(job => job.agentName);
				return { ...a, available: homeKey(a.home) === homeKey(this.home), waitingFor, status: waitingFor.length ? 'waiting' : this.running.has(a.threadId) || this.busy(a.threadId) ? 'working' : 'idle' };
			});
	}
	projectFor(cwd) { return this.projects?.filter(p => homeKey(cwd) === homeKey(p) || homeKey(cwd).startsWith(homeKey(p) + path.sep)).sort((a, b) => b.length - a.length)[0] || path.resolve(cwd); }
	hasWaitPath(from, to, seen = new Set()) {
		if (from === to) { return true; }
		if (seen.has(from)) { return false; }
		seen.add(from);
		return [...(this.waiting.get(from) || [])].some(job => this.hasWaitPath(job.targetThreadId, to, seen));
	}
	async send(source, recipient, message) {
		if (typeof message !== 'string' || !message.trim() || message.length > 32000) { throw new Error('Messaggio vuoto o troppo lungo.'); }
		if (typeof recipient !== 'string' || !recipient.trim()) { throw new Error('Agente destinatario non valido.'); }
		const agents = await this.list();
		const target = agents.find(a => a.id === recipient || nameKey(a.name) === nameKey(recipient.replace(/^@/, '')));
		if (!target) { throw new Error('Agente non presente: aggiorna i riferimenti.'); }
		if (!target.available) { throw new Error('Agente in un altro environment: apri il suo environment prima di inviare.'); }
		if (target.threadId === source) { throw new Error('Non puoi inviare alla stessa chat.'); }
		if (this.hasWaitPath(target.threadId, source)) { throw new Error('Delegazione annullata: creerebbe un ciclo di attesa tra agenti.'); }
		const sender = agents.find(a => a.threadId === source);
		const job = { id: randomUUID(), agentId: target.id, agentName: target.name, targetThreadId: target.threadId, source, sourceName: sender ? '@' + sender.name : 'chat richiedente', message };
		let resolve, reject;
		const completion = new Promise((res, rej) => { resolve = res; reject = rej; });
		job.resolve = resolve; job.reject = reject;
		const waiting = this.waiting.get(source) || new Set(); waiting.add(job); this.waiting.set(source, waiting); this.changed();
		try {
			this.enqueue(target.threadId, job);
			const [, result] = await Promise.all([this.flush(target.threadId), completion]);
			return result;
		} finally {
			waiting.delete(job); if (!waiting.size) { this.waiting.delete(source); } this.changed();
		}
	}
	enqueue(threadId, job) {
		if (this.disposed) { throw new Error('Collegamento agenti chiuso.'); }
		const count = [...this.queues.values()].reduce((n, jobs) => n + jobs.length, 0);
		if (count >= 64) { throw new Error('Coda agenti piena. Attendi gli incarichi in corso.'); }
		const queue = this.queues.get(threadId) ?? []; queue.push(job); this.queues.set(threadId, queue); this.changed();
	}
	flush(threadId) {
		if (this.draining.has(threadId)) { return this.draining.get(threadId); }
		const task = this.drain(threadId).finally(() => this.draining.delete(threadId)); this.draining.set(threadId, task); return task;
	}
	async drain(threadId) {
		const generation = this.generation;
		while (!this.disposed && generation === this.generation && !this.running.has(threadId) && !this.busy(threadId)) {
			const queue = this.queues.get(threadId), job = queue?.[0];
			if (!job) { this.queues.delete(threadId); return; }
			try {
				if (job.agentId && !(await this.store.load()).agents.some(a => a.id === job.agentId && a.threadId === threadId && homeKey(a.home) === homeKey(this.home))) { throw new Error('Agente eliminato prima della consegna.'); }
				const read = await this.request('thread/read', { threadId, includeTurns: false });
				if (this.disposed || generation !== this.generation) { return; }
				if (read.thread.status?.type === 'active') { return; }
				if (read.thread.status?.type === 'notLoaded') { await this.request('thread/resume', await this.prepare({ threadId, excludeTurns: true, model: read.thread.model, modelProvider: read.thread.modelProvider, cwd: read.thread.cwd })); }
				if (this.disposed || generation !== this.generation) { return; }
				queue.shift(); this.running.set(threadId, job);
				const text = `[Richiesta di ${job.sourceName} a @${job.agentName}]\n${job.message}\n\nSei nella chat esistente di @${job.agentName}: usa la tua conversazione come contesto insieme a questa richiesta. Esegui il lavoro qui e rispondi con il risultato finale. Il chiamante è in attesa e riceverà questa risposta direttamente; non creare un subagente per impersonare il destinatario e non rinviare il risultato con send_message.`;
				const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text }] });
				job.turnId = result.turn.id; job.started = true; this.changed(); return;
			} catch (error) {
				if (queue[0] === job) { queue.shift(); } this.running.delete(threadId); job.error = error.message;
				job.reject?.(error);
				this.changed(error.message);
			}
		}
	}
	message(threadId, turnId, text) {
		const job = this.running.get(threadId);
		if (job && (!job.turnId || job.turnId === turnId)) { job.output = text; }
	}
	async completed(threadId, turn) {
		const job = this.running.get(threadId);
		if (job && (!job.turnId || job.turnId === turn.id)) {
			this.running.delete(threadId);
			const result = turn.status === 'completed' ? job.output || 'Incarico concluso senza risposta testuale.' : `Incarico ${turn.status}: ${turn.error?.message || 'nessun risultato finale'}`;
			job.resolve?.({ status: turn.status, messageId: job.id, agent: job.agentName, result });
		}
		await this.flush(threadId); this.changed();
	}
	dispose() { this.disposed = true; const jobs = [...this.running.values(), ...[...this.queues.values()].flat()]; for (const job of jobs) { job.reject?.(new Error('Collegamento agenti chiuso.')); } this.queues.clear(); this.running.clear(); this.waiting.clear(); }
	get hasPendingWork() { return this.running.size > 0 || [...this.queues.values()].some(queue => queue.length > 0); }
	reset() { const pending = this.hasPendingWork; this.generation++; const jobs = [...this.running.values(), ...[...this.queues.values()].flat()]; for (const job of jobs) { job.reject?.(new Error('Connessione Codex interrotta: incarico agente non completato.')); } this.queues.clear(); this.running.clear(); this.waiting.clear(); if (pending) { this.changed('Connessione Codex interrotta: gli incarichi agenti pendenti non sono stati ritentati. Verifica lo stato delle chat.'); } }
}

function create(owner, accounts, vscode = require('vscode')) {
	const store = new AgentStore(process.env.ZILPIO_PROFILES_ROOT), home = process.env.CODEX_HOME;
	const projects = vscode.workspace?.workspaceFolders?.map(folder => folder.uri.fsPath) || [];
	const keys = new Map(), starts = new Map(), threadKeys = new Map();
	let endpoint, ready, disposed = false;
	let updateScheduled = false;
	const report = error => {
		if (error) { owner.broadcastToAllViews({ type: 'zilpio-agents-error', error }); }
		if (!updateScheduled && !disposed) {
			updateScheduled = true;
			setImmediate(() => { updateScheduled = false; router.list().then(agents => { if (!disposed) { owner.broadcastToAllViews({ type: 'zilpio-agents-state', agents }); } }).catch(e => owner.broadcastToAllViews({ type: 'zilpio-agents-error', error: e.message })); });
		}
	};
	const router = new AgentRouter({ store, home, projects, request: (method, params) => accounts.request(method, params), busy: id => accounts.switching || !accounts.current || accounts.activeTurns.has(id) || [...accounts.pendingTurnStarts.values()].includes(id), changed: report, prepare: params => prepareRequest('thread/resume', params) });
	const server = http.createServer(async (req, res) => {
		res.setHeader('content-type', 'application/json');
		try {
			const source = keys.get(req.headers.authorization);
			if (req.method !== 'POST' || req.url !== '/' || !source || req.headers.origin) { res.writeHead(403); res.end('{}'); return; }
			let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 131072) { throw new Error('Richiesta troppo grande.'); } }
			const input = JSON.parse(text);
			if (input.action === 'list') { const agents = await router.list(); res.end(JSON.stringify({ agents, self: agents.find(a => a.threadId === source) || null })); }
			else if (input.action === 'send') { await accounts.bootstrap(); if (accounts.switching || !accounts.current) { throw new Error('Seleziona un account e attendi la fine del cambio.'); } res.end(JSON.stringify(await router.send(source, input.recipient, input.message))); }
			else { throw new Error('Operazione agente sconosciuta.'); }
		} catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
	});
	server.requestTimeout = 70000;
	server.on('error', error => report(error.message));
	async function prepareRequest(method, params, requestId) {
		if (!['thread/start', 'thread/resume', 'thread/fork'].includes(method)) { return params; }
		if (disposed) { throw new Error('Collegamento agenti chiuso.'); }
		if (!ready) { ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); server.unref(); endpoint = `http://127.0.0.1:${server.address().port}`; resolve(); }); }); }
		await ready;
		let key = method === 'thread/resume' ? threadKeys.get(params.threadId) : undefined;
		if (!key) { key = randomUUID(); }
		if (method === 'thread/resume') { keys.set(key, params.threadId); threadKeys.set(params.threadId, key); }
		else if (requestId !== undefined) { starts.set(String(requestId), key); }
		const config = { ...params.config, 'mcp_servers.zilpio_agents': { command: process.execPath, args: [path.join(__dirname, 'agents-mcp.js'), endpoint, key], env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true, required: true } };
		// Resumes inherit saved instructions. Do not replace instructions the caller did not supply.
		if (method !== 'thread/start' && !params.developerInstructions) { return { ...params, config }; }
		const existing = params.developerInstructions || '';
		return { ...params, config, developerInstructions: existing.includes(routingInstructions) ? existing : [existing, routingInstructions].filter(Boolean).join('\n\n') };
	}
	async function state(webview, requestId, saved = false) {
		const data = { type: 'zilpio-agents-state', requestId, agents: await router.list(), saved };
		if (saved) { owner.broadcastToAllViews(data); } else { owner.postMessageToWebview(webview, data); }
	}
	async function handle(webview, message) {
		try {
			if (message.action === 'suggest') { owner.postMessageToWebview(webview, { type: 'zilpio-agents-state', requestId: message.requestId, suggestion: await store.suggest() }); return; }
			if (message.action === 'create') {
				const read = await accounts.request('thread/read', { threadId: message.threadId, includeTurns: false });
				if (read.thread?.id !== message.threadId) { throw new Error('Chat non trovata.'); }
				if (!read.thread.cwd || !projects.length || !projects.some(p => homeKey(router.projectFor(read.thread.cwd)) === homeKey(p))) { throw new Error('Apri il progetto della chat prima di creare il suo agente.'); }
				await store.create({ threadId: message.threadId, home, project: router.projectFor(read.thread.cwd), name: message.name, color: message.color, originalTitle: read.thread.name || read.thread.preview });
			} else if (message.action === 'edit') { await store.edit(message.id, { name: message.name, color: message.color }); }
			else if (message.action === 'delete') { await store.remove(message.id); }
			else if (message.action === 'open') {
				const agent = (await router.list()).find(a => a.id === message.id);
				if (!agent?.available) { throw new Error('Agente in un altro environment.'); }
				const path = `/local/${encodeURIComponent(agent.threadId)}`;
				if (owner.findPanelByWebview?.(webview)) { await owner.handleMessage(webview, { type: 'navigate-in-new-editor-tab', path }); }
				else { owner.postMessageToWebview(webview, { type: 'navigate-to-route', path }); }
				await state(webview, message.requestId); return;
			} else if (message.action !== 'list') { throw new Error('Operazione agente non valida.'); }
			await state(webview, message.requestId, message.action !== 'list');
		} catch (error) { owner.postMessageToWebview(webview, { type: 'zilpio-agents-state', requestId: message.requestId, error: error.message }); }
	}
	const service = { handle, prepareRequest, router, store,
		resetActivity() { router.reset(); },
		receive(message) {
			const key = starts.get(String(message.id));
			if (key) { starts.delete(String(message.id)); const id = message.result?.thread?.id; if (id) { keys.set(key, id); threadKeys.set(id, key); } }
		},
		notification(method, params) {
			if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase !== 'commentary') { router.message(params.threadId, params.turnId, params.item.text); }
			if (method === 'turn/completed') { void router.completed(params.threadId, params.turn).catch(e => report(e.message)); }
			if (method === 'thread/status/changed' && params.status?.type === 'idle') { void router.flush(params.threadId).catch(e => report(e.message)); }
			if (method === 'turn/started' || method === 'turn/completed' || method === 'thread/status/changed') { report(); }
		},
		dispose() { disposed = true; router.dispose(); keys.clear(); starts.clear(); server.close(); }
	};
	owner.subscriptions.push(service);
	return service;
}
module.exports = { AgentStore, AgentRouter, create, colors };
