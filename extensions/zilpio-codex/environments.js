/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { ProfileStore, validate } = require('./profiles.js');

class EnvironmentStore extends ProfileStore {
	constructor(root, userHome = os.homedir()) {
		super(root, [
			{ id: 'work', name: 'Work', provider: 'openai', home: path.join(userHome, '.codex-work') },
			{ id: 'codex', name: 'Codex', provider: 'openai', home: path.join(userHome, '.codex') }
		], { fileName: 'environments.json', includeMissingSeeds: true, userHome });
	}
}

// Runs before the official host reads config, watches files or starts its app-server.
function applyEnvironment(env = process.env, userHome = os.homedir(), folder) {
	if (!env.ZILPIO_PROFILES_ROOT) { return; }
	if (!path.isAbsolute(env.ZILPIO_PROFILES_ROOT)) { throw new Error('Environment registry root must be an absolute path.'); }
	const store = new EnvironmentStore(env.ZILPIO_PROFILES_ROOT, userHome);
	let db;
	try { db = validate(JSON.parse(fs.readFileSync(store.file, 'utf8'))); }
	catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	const workspace = require('./workspaces.js').selectedWorkspace(env.ZILPIO_PROFILES_ROOT, folder);
	const selectedId = workspace?.environmentId ?? db?.activeProfileId;
	const selected = (db?.profiles ?? store.seeds).find(p => p.id === (selectedId ?? store.seeds[0]?.id));
	if (!selected) { throw new Error('Seleziona un environment nel registro environments.json.'); }
	if (path.resolve(selected.home).toLowerCase() !== path.resolve(userHome, '.codex').toLowerCase() && fs.existsSync(path.join(selected.home, 'auth.json'))) {
		throw new Error('auth.json non consentito negli environment Zilpio. Sposta le credenziali in .codex-account prima di continuare.');
	}
	env.CODEX_HOME = selected.home;
}

class EnvironmentService {
	constructor(store, accounts, reload) {
		this.store = store;
		this.accounts = accounts;
		this.reload = reload;
	}
	async initialize(home) {
		const db = await this.store.load();
		this.current = db.profiles.find(p => path.resolve(p.home) === path.resolve(home));
		if (!this.current) { throw new Error('Environment attivo non presente nel registro. Ricarica la finestra.'); }
	}
	async list() {
		const db = await this.store.load();
		return { activeEnvironmentId: this.current?.id, environments: db.profiles.map(({ id, name, home }) => ({ id, name, home })), error: this.startupError };
	}
	async select(id) {
		if (this.accounts.switching) { throw new Error('Attendi il cambio account o environment.'); }
		this.accounts.switching = true;
		const previous = this.current;
		let persisted = false, perWorkspace = false;
		const persist = async targetId => {
			perWorkspace = await this.accounts.workspaces?.persistSelection('environmentId', targetId) ?? false;
			if (!perWorkspace) { await this.store.select(targetId); }
		};
		try {
			await this.accounts.assertIdle();
			const db = await this.store.load();
			const selected = db.profiles.find(p => p.id === id);
			if (!selected) { throw new Error('Environment non presente nel registro.'); }
			if (selected.home === previous?.home && !this.startupError) {
				await persist(id); this.current = selected; return;
			}
			await persist(id); persisted = true;
			await this.accounts.assertIdle();
			await this.reload();
			this.current = selected;
			this.startupError = undefined;
		} catch (error) {
			if (persisted && previous) {
				if (perWorkspace) { await this.accounts.workspaces.persistSelection('environmentId', previous.id); }
				else { await this.store.select(previous.id); }
			}
			throw error;
		} finally { this.accounts.switching = false; }
	}
}

function create(owner, accounts) {
	const vscode = require('vscode');
	const store = new EnvironmentStore(process.env.ZILPIO_PROFILES_ROOT);
	let reset;
	const service = new EnvironmentService(store, accounts, async () => {
		await service.prepareReload();
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	});
	service.prepareReload = async () => {
		await vscode.commands.executeCommand('chatgpt.newChat');
		const requestId = randomUUID();
		let timer;
		try {
			await new Promise((resolve, reject) => {
				reset = { requestId, resolve };
				timer = setTimeout(() => reject(new Error('Il pannello Codex non ha confermato il cambio environment. Riprova.')), 10000);
				const message = { type: 'zilpio-environments-reset', requestId };
				if (owner.sidebarView && owner.sidebarWebviewReady) { owner.postMessageToWebview(owner.sidebarView.webview, message); }
				else { owner.pendingSidebarMessages.push(message); }
			});
		} finally { clearTimeout(timer); reset = undefined; }
		// Custom chat editors restore their conversation URI independently of sidebar state.
		for (const panel of [...owner.editorPanels.keys()]) { panel.dispose(); }
	};
	service.startupError = process.env.ZILPIO_ENVIRONMENT_ERROR;
	const ready = service.initialize(process.env.CODEX_HOME);
	ready.catch(() => {});
	const report = async (webview, error) => {
		let state = {};
		try { state = await service.list(); } catch { /* Keep malformed JSON editable. */ }
		owner.postMessageToWebview(webview, { type: 'zilpio-environments-state', ...state, error: error.message });
		void vscode.window.showErrorMessage(`Environment Codex: ${error.message}`);
	};
	service.handle = async (webview, message) => {
		if (message.action === 'reset-complete') {
			if (reset?.requestId === message.requestId && webview === owner.sidebarView?.webview) { reset.resolve(); }
			return;
		}
		try {
			// Editing remains available even when the registry contains invalid settings.
			if (message.action === 'edit') {
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(store.file)));
			} else {
				await ready;
				if (message.action === 'select') { await service.select(message.environmentId); }
				else if (message.action === 'new') {
					await accounts.assertIdle();
					const name = await vscode.window.showInputBox({ prompt: 'Nome del nuovo environment Codex', ignoreFocusOut: true });
					if (name) { const environment = await store.create(name); await service.select(environment.id); }
				}
				else if (message.action !== 'list') { return; }
			}
			owner.broadcastToAllViews({ type: 'zilpio-environments-state', ...(await service.list()) });
		} catch (error) { await report(webview, error); }
	};
	const subscription = vscode.workspace.onDidSaveTextDocument(document => {
		if (document.uri.fsPath !== store.file) { return; }
		void (async () => {
			const db = await store.load();
			if (!service.current || service.startupError) { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return; }
			await ready;
			await service.select(db.activeProfileId);
			owner.broadcastToAllViews({ type: 'zilpio-environments-state', ...(await service.list()) });
		})().catch(error => { void vscode.window.showErrorMessage(`Environment Codex: ${error.message}`); });
	});
	owner.subscriptions.push(subscription);
	return service;
}
module.exports = { EnvironmentStore, EnvironmentService, applyEnvironment, create };
