'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { ProfileStore } = require('./profiles.js');
const { readAuthentication } = require('./backend.js');
const { withAccountRpc } = require('./account-auth.js');

class OfficialProfiles {
	constructor({ store, request, authenticate = readAuthentication, binary, confirm }) {
		this.store = store;
		this.request = request;
		this.authenticate = authenticate;
		this.binary = binary;
		this.confirm = confirm;
		this.activeTurns = new Set();
		this.pendingTurnStarts = new Map();
		this.pending = new Map();
		this.promptSnapshots = new Map();
		this.switching = false;
	}
	async confirmTurn(params) {
		const model = params.collaborationMode?.settings?.model ?? params.model ?? '';
		const family = /(?:^|[-_])(astra|sol)(?:$|[-_])/i.exec(model)?.[1].toLowerCase();
		if (family === 'astra' || family === 'sol' && ['priority', 'fast', 'ultrafast'].includes(params.serviceTier)) {
			return await this.confirm(family);
		}
		return true;
	}
	async list() {
		const db = await this.store.load();
		return { activeProfileId: this.current?.id ?? null, profiles: db.profiles.map(({ id, name }) => ({ id, name })), workspaceColor: await this.workspaces?.color() ?? null };
	}
	notification(method, params) {
		if (method === 'turn/started') { this.activeTurns.add(params.threadId); }
		if (method === 'turn/completed') { this.activeTurns.delete(params.threadId); }
		if (method === 'thread/status/changed') {
			if (params.status?.type === 'active') { this.activeTurns.add(params.threadId); } else { this.activeTurns.delete(params.threadId); }
		}
		this.agents?.notification(method, params);
	}
	async assertIdle() {
		if (this.agents?.router.hasPendingWork) { throw new Error('Attendi gli incarichi ZilpioAgent prima di cambiare account o environment.'); }
		if (this.activeTurns.size || this.pendingTurnStarts.size) { throw new Error('Attendi la fine del turno o interrompilo prima di cambiare account.'); }
		const loaded = await this.request('thread/loaded/list', {});
		for (const threadId of loaded.data || []) {
			const result = await this.request('thread/read', { threadId, includeTurns: false });
			if (result.thread?.status?.type === 'active') { throw new Error('Attendi la fine del turno o interrompilo prima di cambiare account.'); }
		}
	}
	resetActivity() {
		this.promptSnapshots.clear();
		this.pendingTurnStarts.clear();
		this.activeTurns.clear();
		this.agents?.resetActivity();
	}
	async switch(id, persist = true) {
		if (this.switching) { throw new Error('Cambio account già in corso.'); }
		this.switching = true;
		const previous = this.current;
		let applied = false;
		try {
			await this.assertIdle();
			const db = await this.store.load();
			const profile = db.profiles.find(p => p.id === id);
			if (!profile) { throw new Error('Account non presente nel registro JSON.'); }
			const credentials = await this.authenticate(await this.binary(), profile);
			if (this.activeTurns.size) { throw new Error('Attendi la fine del turno prima di cambiare account.'); }
			await this.login(credentials, () => { applied = true; });
			applied = true;
			if (persist && !await this.workspaces?.persistSelection('accountId', profile.id)) { await this.store.select(profile.id); }
			this.current = profile;
			this.startupError = undefined;
		} catch (error) {
			if (applied && previous) {
				try { await this.login(await this.authenticate(await this.binary(), previous)); }
				catch { this.current = null; throw new Error('Cambio account fallito e ripristino non riuscito. Seleziona nuovamente un account prima di inviare.'); }
			} else if (applied) { await this.request('account/logout', {}); }
			throw error;
		} finally { this.switching = false; }
	}
	async login(credentials, resetting = () => {}) {
		try { await this.request('account/login/start', credentials); }
		catch (error) {
			if (credentials.type !== 'apiKey' || !/^External auth is active\b/.test(error.message)) { throw error; }
			// Codex requires clearing host-supplied ChatGPT tokens before API-key login.
			resetting();
			await this.request('account/logout', {});
			await this.request('account/login/start', credentials);
		}
	}
	receive(message) {
		this.agents?.receive(message);
		const snapshot = this.promptSnapshots.get(String(message.id));
		if (snapshot) {
			this.promptSnapshots.delete(String(message.id));
			if (!message.error) { this.startupSaved = this.startup.record(snapshot).catch(error => { this.startupError = error.message; }); }
		}
		const startingThread = this.pendingTurnStarts.get(String(message.id));
		if (startingThread) {
			this.pendingTurnStarts.delete(String(message.id));
			if (!message.error) { this.activeTurns.add(startingThread); }
		}
		const pending = this.pending.get(String(message.id));
		if (!pending) { return false; }
		this.pending.delete(String(message.id)); clearTimeout(pending.timer);
		if (message.error) { pending.reject(new Error(message.error.message || 'Richiesta Codex fallita.')); } else { pending.resolve(message.result); }
		return true;
	}
	trackPrompt(id, params) {
		if (!this.startup || !this.current || !this.project) { return; }
		this.promptSnapshots.set(String(id), { project: this.project, accountId: this.current.id, environmentId: this.environmentId, params: { model: params.model, effort: params.effort, serviceTier: params.serviceTier, collaborationMode: params.collaborationMode } });
	}
	handleServerRequest(message, respond) {
		if (message.method !== 'account/chatgptAuthTokens/refresh' || !this.current) { return false; }
		const profile = this.current;
		Promise.resolve().then(async () => {
			const auth = await this.authenticate(await this.binary(), profile);
			if (this.current?.id !== profile.id || auth.type !== 'chatgptAuthTokens' || (message.params.previousAccountId && message.params.previousAccountId !== auth.chatgptAccountId)) { throw new Error('Account del profilo cambiato.'); }
			respond(message.id, { accessToken: auth.accessToken, chatgptAccountId: auth.chatgptAccountId, chatgptPlanType: auth.chatgptPlanType ?? null });
		}).catch(() => respond(message.id, { accessToken: '', chatgptAccountId: message.params.previousAccountId || '', chatgptPlanType: null }));
		return true;
	}
}

function create(owner, send, binary) {
	const vscode = require('vscode');
	const root = process.env.ZILPIO_PROFILES_ROOT;
	if (!root || !path.isAbsolute(root)) { throw new Error('Avvia ZilpioStudioCode tramite ZSCode.exe per usare gli account.'); }
	const seeds = require('./profiles.json').profiles;
	const service = new OfficialProfiles({ store: new ProfileStore(root, seeds), binary: async () => binary(), confirm: async model => {
		const message = model === 'astra' ? vscode.l10n.t('sei sicuro di usare astra???') : vscode.l10n.t('sei sicuro di usare sol con Speed acceso???');
		const send = vscode.l10n.t('Invia');
		return await vscode.window.showWarningMessage(message, { modal: true }, send) === send;
	}, request: (method, params) => {
		const id = `zilpio-profile-${randomUUID()}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { service.pending.delete(id); reject(new Error('Codex non ha risposto al cambio account.')); }, 60000);
			timer.unref(); service.pending.set(id, { resolve, reject, timer });
			if (method === 'turn/start') { service.pendingTurnStarts.set(id, params.threadId); }
			try { send(id, method, params); } catch (error) { clearTimeout(timer); service.pending.delete(id); service.pendingTurnStarts.delete(id); reject(error); }
		});
	} });
	let bootstrap;
	service.startup = new (require('./startup-state.js').StartupState)(root);
	service.project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	service.startupHtml = async html => {
		const saved = await service.startup.load();
		const matching = saved && service.project && path.resolve(saved.project).toLowerCase() === path.resolve(service.project).toLowerCase() && saved.accountId === service.current?.id && saved.environmentId === service.environmentId;
		return html.replace('<head>', `<head><meta name="zilpio-startup" content="${encodeURIComponent(JSON.stringify(matching ? saved : null))}">`);
	};
	service.agents = require('./agents.js').create(owner, service, vscode);
	const models = new (require('./model-settings.js').ModelSettings)(root, (method, params) => service.request(method, params));
	service.handleModels = async (webview, message) => {
		try {
			await service.bootstrap();
			if (service.switching) { throw new Error('Attendi il cambio account.'); }
			const profileId = service.current?.id;
			const catalog = await models.catalog();
			if (service.switching || service.current?.id !== profileId) { throw new Error('Account cambiato. Aggiorna il catalogo.'); }
			if (message.action === 'save' && message.profileId !== profileId) { throw new Error('Account cambiato. Aggiorna il catalogo.'); }
			const preferences = message.action === 'save' ? await models.save(message.models, catalog) : await models.load();
			const state = { type: 'zilpio-models-state', requestId: message.requestId, catalog, preferences, profileId, saved: message.action === 'save' };
			if (state.saved) { owner.broadcastToAllViews(state); } else { owner.postMessageToWebview(webview, state); }
		} catch (error) { owner.postMessageToWebview(webview, { type: 'zilpio-models-state', requestId: message.requestId, error: error.message }); }
	};
	service.bootstrap = () => {
		if (!bootstrap) {
			bootstrap = service.store.load().then(async db => {
				const environments = await new (require('./environments.js').EnvironmentStore)(root).load();
				service.environmentId = environments.profiles.find(profile => path.resolve(profile.home).toLowerCase() === path.resolve(process.env.CODEX_HOME).toLowerCase())?.id;
				const selected = require('./workspaces.js').selectedWorkspace(root, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
				const id = selected?.accountId ?? db.activeProfileId;
				return id && service.switch(id, !selected);
			}).catch(error => { service.startupError = error.message; });
		}
		return bootstrap;
	};
	service.workspaces = require('./workspaces.js').register(owner, service, vscode);
	const connect = async profile => {
		const choice = await vscode.window.showQuickPick(['ChatGPT nel browser', 'Chiave API OpenAI'], { title: `Collega ${profile.name}` });
		if (!choice) { return false; }
		return withAccountRpc(await service.binary(), profile, async worker => {
			await worker.initialize();
			if (choice === 'Chiave API OpenAI') {
				const key = await vscode.window.showInputBox({ prompt: 'Chiave API OpenAI', password: true, ignoreFocusOut: true });
				if (!key) { return false; }
				await worker.request('account/login/start', { type: 'apiKey', apiKey: key });
			} else {
				let timer;
				const completion = new Promise((resolve, reject) => {
					timer = setTimeout(() => reject(new Error('Accesso scaduto. Riprova.')), 300000);
					worker.on('notification', (method, params) => { if (method === 'account/login/completed') { params.success ? resolve() : reject(new Error('Accesso non completato.')); } });
					worker.on('closed', () => reject(new Error('Accesso interrotto.')));
				});
				completion.catch(() => {});
				try {
					const result = await worker.request('account/login/start', { type: 'chatgpt' });
					const url = new URL(result.authUrl);
					if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) { throw new Error('URL di accesso non valido.'); }
					await vscode.env.openExternal(vscode.Uri.parse(url.href));
					await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Accesso a ${profile.name}`, cancellable: true }, async (_, token) => {
						const subscription = token.onCancellationRequested(() => worker.dispose());
						try { await completion; } finally { subscription.dispose(); }
					});
				} finally { clearTimeout(timer); }
			}
			return true;
		});
	};
	service.handle = async (webview, message) => {
		try {
			if (message.action === 'list') {
				await service.bootstrap();
			} else if (['pick', 'select', 'new', 'edit'].includes(message.action)) {
				if (service.switching || service.activeTurns.size) { throw new Error('Attendi la fine del turno prima di cambiare account.'); }
				const list = await service.list();
				const choice = message.action === 'pick'
					? await vscode.window.showQuickPick([...list.profiles.map(p => ({ label: `${p.id === list.activeProfileId ? '$(check) ' : ''}${p.name}`, id: p.id })), { label: '$(add) Nuovo account…', action: 'new' }, { label: '$(edit) Modifica registro JSON', action: 'edit' }], { title: 'Account Codex', placeHolder: 'Scegli l’account per il prossimo turno della stessa chat' })
					: message.action === 'select' ? { id: message.profileId } : { action: message.action };
				if (choice?.action === 'new') {
					const name = await vscode.window.showInputBox({ prompt: 'Nome del nuovo account Codex', ignoreFocusOut: true });
					if (name) { const profile = await service.store.create(name); if (await connect(profile)) { await service.switch(profile.id); } }
				} else if (choice?.action === 'edit') {
					await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(service.store.file)));
				} else if (choice) {
					try { await service.switch(choice.id); }
					catch (error) {
						if (!/Collega un account/.test(error.message)) { throw error; }
						const profile = (await service.store.load()).profiles.find(p => p.id === choice.id);
						if (await connect(profile)) { await service.switch(profile.id); }
					}
				}
			} else { return; }
			owner.broadcastToAllViews({ type: 'zilpio-profiles-state', ...(await service.list()) });
		} catch (error) {
			owner.postMessageToWebview(webview, { type: 'zilpio-profiles-state', ...(await service.list()), error: error.message });
			void vscode.window.showErrorMessage(`Account Codex: ${error.message}`);
		}
	};
	return service;
}
module.exports = { OfficialProfiles, create };
