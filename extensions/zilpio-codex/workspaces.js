/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ProfileStore, writeJson } = require('./profiles.js');
const { startRpc } = require('./rpc.js');
const { withAccountRpc } = require('./account-auth.js');

function folderKey(folder) {
	const resolved = path.resolve(folder);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function validate(db) {
	if (db?.version !== 1 || !Array.isArray(db.workspaces) || !Array.isArray(db.usageCards) || !db.selections || typeof db.selections !== 'object' || Array.isArray(db.selections)) { throw new Error('Registro workspace non valido.'); }
	for (const cards of [db.workspaces, db.usageCards]) {
		const ids = new Set();
		for (const card of cards) {
			if (!card || typeof card.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(card.id) || ids.has(card.id) || typeof card.name !== 'string' || !card.name.trim() || card.name.length > 100 || typeof card.accountId !== 'string' || !card.accountId) { throw new Error('Card non valida o duplicata.'); }
			if (typeof card.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(card.color)) { throw new Error('Colore non valido: usa #RRGGBB.'); }
			if (cards === db.workspaces && (typeof card.folder !== 'string' || !path.isAbsolute(card.folder) || typeof card.environmentId !== 'string' || !card.environmentId)) { throw new Error('Cartella o environment non valido.'); }
			ids.add(card.id);
		}
	}
	for (const selection of Object.values(db.selections)) {
		if (!selection || !['id', 'accountId', 'environmentId'].every(key => typeof selection[key] === 'string' && /^[a-zA-Z0-9_-]+$/.test(selection[key]))) { throw new Error('Selezione workspace non valida.'); }
	}
	return db;
}
class WorkspaceStore extends ProfileStore {
	constructor(root) { super(root, [], { fileName: 'workspaces.json' }); }
	async load() {
		await fsp.mkdir(this.root, { recursive: true });
		try { return validate(JSON.parse(await fsp.readFile(this.file, 'utf8'))); }
		catch (error) {
			if (error.code !== 'ENOENT') { throw error; }
			const db = { version: 1, workspaces: [], usageCards: [], selections: {} };
			try { await fsp.writeFile(this.file, JSON.stringify(db, null, 2), { flag: 'wx', mode: 0o600 }); }
			catch (error) { if (error.code === 'EEXIST') { return this.load(); } throw error; }
			return db;
		}
	}
	update(change) {
		return this.serialize(async () => {
			const db = await this.load();
			await change(db);
			await writeJson(this.file, validate(db));
			return db;
		});
	}
}
function selectedWorkspace(root, folder) {
	if (!root || !folder) { return undefined; }
	try { return validate(JSON.parse(fs.readFileSync(path.join(root, 'workspaces.json'), 'utf8'))).selections[folderKey(folder)]; }
	catch (error) { if (error.code === 'ENOENT') { return undefined; } throw error; }
}
class WorkspaceService {
	constructor({ store, accounts, profiles, environments, open, createRpc = startRpc, folder = () => undefined }) {
		Object.assign(this, { store, accounts, profiles, environments, open, createRpc, folder });
		this.usagePending = new Map();
	}
	async color() {
		const folder = this.folder();
		if (!folder) { return null; }
		const db = await this.store.load();
		const matches = db.workspaces.filter(card => folderKey(card.folder) === folderKey(folder));
		return (matches.find(card => card.id === db.selections[folderKey(folder)]?.id) ?? matches[0])?.color ?? null;
	}
	async select(id) {
		if (this.accounts.switching) { throw new Error('Cambio già in corso.'); }
		clearTimeout(this.reloadTimer);
		this.switchError = undefined;
		this.accounts.switching = true;
		let previous, key, snapshot, saved = false;
		try {
			await this.accounts.assertIdle();
			const card = (await this.store.load()).workspaces.find(card => card.id === id);
			if (!card) { throw new Error('Workspace non presente.'); }
			if (!(await fsp.stat(card.folder)).isDirectory()) { throw new Error('La cartella non è una directory.'); }
			const account = (await this.profiles.load()).profiles.find(p => p.id === card.accountId);
			const environment = (await this.environments.load()).profiles.find(p => p.id === card.environmentId);
			if (!account) { throw new Error('Account non presente. Modifica la card.'); }
			if (!environment) { throw new Error('Environment non presente. Modifica la card.'); }
			await this.accounts.authenticate(await this.accounts.binary(), account);
			await fsp.mkdir(environment.home, { recursive: true });
			await this.accounts.assertIdle();
			key = folderKey(card.folder);
			snapshot = { id: card.id, accountId: account.id, environmentId: environment.id };
			await this.store.update(db => {
				previous = db.selections[key];
				db.selections[key] = snapshot;
			});
			saved = true;
			await this.open(card.folder);
			this.reloadTimer = setTimeout(() => {
				this.reloadRecovery = this.restoreSelection(key, previous, snapshot).catch(error => { this.switchError = error.message; }).finally(() => {
					this.accounts.switching = false;
					this.switchError ||= 'Il cambio workspace è stato annullato. Riprova dopo aver salvato i file aperti.';
				});
			}, 12000);
			this.reloadTimer.unref?.();
			// Keep new turns blocked until the old extension host is unloaded.
		} catch (error) {
			try {
				if (saved) { await this.restoreSelection(key, previous, snapshot); }
			} finally { this.accounts.switching = false; }
			throw error;
		}
	}
	restoreSelection(key, previous, snapshot) {
		return this.store.update(db => {
			if (!['id', 'accountId', 'environmentId'].every(field => db.selections[key]?.[field] === snapshot[field])) { return; }
			if (previous) { db.selections[key] = previous; } else { delete db.selections[key]; }
		});
	}
	dispose() { clearTimeout(this.reloadTimer); }
	async persistSelection(field, id) {
		if (!['accountId', 'environmentId'].includes(field)) { throw new Error('Impostazione workspace non valida.'); }
		const folder = this.folder();
		if (!folder || !selectedWorkspace(this.store.root, folder)) { return false; }
		let updated = false;
		await this.store.update(db => {
			const selection = db.selections[folderKey(folder)];
			if (selection) { selection[field] = id; updated = true; }
		});
		return updated;
	}
	usage(accountId) {
		if (this.usagePending.has(accountId)) { return this.usagePending.get(accountId); }
		const result = this.readUsage(accountId).finally(() => this.usagePending.delete(accountId));
		this.usagePending.set(accountId, result);
		return result;
	}
	async readUsage(accountId) {
		const account = (await this.profiles.load()).profiles.find(p => p.id === accountId);
		if (!account) { throw new Error('Account non presente.'); }
		return withAccountRpc(await this.accounts.binary(), account, async worker => {
			await worker.initialize();
			const result = await worker.request('account/rateLimits/read', {}, 20000);
			const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
			return [bucket?.primary, bucket?.secondary].filter(w => Number.isFinite(w?.usedPercent)).map(w => ({ usedPercent: Math.max(0, Math.min(100, w.usedPercent)), windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt }));
		}, this.createRpc);
	}
}

function register(owner, accounts, vscode = require('vscode')) {
	const { EnvironmentStore } = require('./environments.js');
	const store = new WorkspaceStore(process.env.ZILPIO_PROFILES_ROOT);
	const service = new WorkspaceService({ store, accounts, profiles: accounts.store, environments: new EnvironmentStore(store.root), folder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, open: async folder => {
		owner.zilpioEnvironments ??= require('./environments.js').create(owner, accounts);
		await owner.zilpioEnvironments.prepareReload();
		if (folderKey(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') === folderKey(folder)) { await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
		else { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceReuseWindow: true }); }
	} });
	owner.subscriptions.push(service);
	owner.subscriptions.push(vscode.commands.registerCommand('zilpio.workspaces.backend', async message => {
		await accounts.bootstrap();
		if (message.action === 'list') {
			const db = await store.load();
			const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const selection = selectedWorkspace(store.root, currentFolder);
			const environments = (await service.environments.load()).profiles;
			const activeEnvironment = environments.find(e => path.resolve(e.home) === path.resolve(process.env.CODEX_HOME));
			const activeCard = db.workspaces.find(card => card.id === selection?.id && card.accountId === accounts.current?.id && card.environmentId === activeEnvironment?.id && currentFolder && folderKey(card.folder) === folderKey(currentFolder));
			return { ...db, profiles: (await accounts.list()).profiles, environments: environments.map(({ id, name }) => ({ id, name })), activeId: activeCard?.id ?? null, busy: accounts.switching || accounts.activeTurns.size > 0 || accounts.pendingTurnStarts.size > 0, switching: accounts.switching, error: service.switchError || accounts.startupError || process.env.ZILPIO_ENVIRONMENT_ERROR };
		}
		if (message.action === 'select') { return service.select(message.id); }
		if (message.action === 'openFolder') {
			await accounts.assertIdle();
			if (accounts.switching) { throw new Error('Cambio già in corso.'); }
			const card = (await store.load()).workspaces.find(card => card.id === message.id);
			if (!card) { throw new Error('Workspace non presente.'); }
			if (!(await fsp.stat(card.folder)).isDirectory()) { throw new Error('La cartella non è una directory.'); }
			return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(card.folder), { forceReuseWindow: true });
		}
		if (message.action === 'usage') {
			if (!(await store.load()).usageCards.some(card => card.accountId === message.accountId)) { throw new Error('Account non visualizzato.'); }
			return service.usage(message.accountId);
		}
		if (message.action === 'save' || message.action === 'delete') {
			if (!['workspaces', 'usageCards'].includes(message.kind)) { throw new Error('Tipo card non valido.'); }
			const db = await store.update(db => {
				if (message.action === 'delete') { db[message.kind] = db[message.kind].filter(card => card.id !== message.id); }
				else {
					const card = message.card;
					const index = db[message.kind].findIndex(item => item.id === card?.id);
					if (index < 0) { db[message.kind].push(card); } else { db[message.kind][index] = card; }
				}
			});
			owner.broadcastToAllViews({ type: 'zilpio-workspace-color', color: await service.color() });
			return db;
		}
		throw new Error('Operazione workspace non valida.');
	}));
	return service;
}
module.exports = { WorkspaceStore, WorkspaceService, selectedWorkspace, register, folderKey };
