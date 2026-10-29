const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore, WorkspaceService, selectedWorkspace } = require('../../extensions/zilpio-codex/workspaces.js');

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-workspaces-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const store = new WorkspaceStore(root);
	const card = { id: 'one', name: 'Progetto', folder: root, accountId: 'a', environmentId: 'e', color: '#7c8aff' };
	await store.update(db => { db.workspaces.push(card); db.usageCards.push({ id: 'u', name: 'Personale', accountId: 'a', color: '#12aaff' }); });
	const accounts = { switching: false, current: { id: 'previous' }, assertIdle: async () => {}, authenticate: async () => ({}), binary: async () => 'codex' };
	const profiles = { load: async () => ({ profiles: [{ id: 'a', name: 'A', home: root }] }) };
	const environments = { load: async () => ({ profiles: [{ id: 'e', name: 'E', home: root }] }) };
	let opened = [];
	const service = new WorkspaceService({ store, accounts, profiles, environments, open: async folder => { opened.push(folder); } });
	t.after(() => service.dispose());
	return { root, store, card, accounts, service, opened };
}

test('persists editable cards and rejects malformed data without overwriting the registry', async t => {
	const { store } = await fixture(t);
	await store.update(db => { db.workspaces[0].name = 'Nuovo'; });
	const before = await store.load();
	assert.equal(before.workspaces[0].name, 'Nuovo');
	await assert.rejects(store.update(db => { db.workspaces[0].color = 'red; background:url(x)'; }), /colore/i);
	assert.deepEqual(await store.load(), before);
	await store.update(db => { db.usageCards = []; });
	assert.equal((await store.load()).workspaces.length, 1);
});

test('chat color follows the registered folder even when opened directly, and clears after deletion', async t => {
	const { root, store, service } = await fixture(t);
	service.folder = () => path.join(root, '.');
	assert.equal(await service.color(), '#7c8aff');
	await store.update(db => { db.workspaces[0].color = '#ff1234'; });
	assert.equal(await service.color(), '#ff1234');
	service.folder = () => path.join(root, 'unregistered');
	assert.equal(await service.color(), null);
	service.folder = () => undefined;
	assert.equal(await service.color(), null);
	service.folder = () => root;
	await store.update(db => { db.workspaces = []; });
	assert.equal(await service.color(), null);
});

test('editing and deleting a workspace broadcasts its outline color to open chats', async t => {
	const { root, accounts } = await fixture(t);
	const previousRoot = process.env.ZILPIO_PROFILES_ROOT;
	process.env.ZILPIO_PROFILES_ROOT = root;
	const subscriptions = [], messages = []; let backend;
	t.after(() => {
		if (previousRoot === undefined) { delete process.env.ZILPIO_PROFILES_ROOT; } else { process.env.ZILPIO_PROFILES_ROOT = previousRoot; }
		for (const item of subscriptions) { item.dispose(); }
	});
	accounts.bootstrap = async () => {};
	require('../../extensions/zilpio-codex/workspaces.js').register({ subscriptions, broadcastToAllViews: message => messages.push(message) }, accounts, {
		workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
		commands: { registerCommand: (_, handler) => { backend = handler; return { dispose() {} }; } }
	});
	await backend({ action: 'save', kind: 'workspaces', card: { id: 'one', name: 'Project', folder: root, accountId: 'a', environmentId: 'e', color: '#123456' } });
	await backend({ action: 'delete', kind: 'workspaces', id: 'one' });
	assert.deepEqual(messages, [{ type: 'zilpio-workspace-color', color: '#123456' }, { type: 'zilpio-workspace-color', color: null }]);
});

test('opens only the card folder in the same window, including from a multi-root workspace', async t => {
	const { root, store, accounts } = await fixture(t);
	const before = await store.load();
	let backend;
	const calls = [], subscriptions = [];
	const previousRoot = process.env.ZILPIO_PROFILES_ROOT;
	process.env.ZILPIO_PROFILES_ROOT = root;
	t.after(() => { if (previousRoot === undefined) { delete process.env.ZILPIO_PROFILES_ROOT; } else { process.env.ZILPIO_PROFILES_ROOT = previousRoot; } for (const item of subscriptions) { item.dispose(); } });
	accounts.bootstrap = async () => {};
	accounts.authenticate = async () => { throw new Error('Folder opening must not authenticate'); };
	require('../../extensions/zilpio-codex/workspaces.js').register({ subscriptions }, accounts, {
		workspace: { workspaceFolders: [{ uri: { fsPath: root } }], workspaceFile: { fsPath: path.join(root, 'project.code-workspace') } },
		Uri: { file: folder => ({ fsPath: folder }) },
		commands: {
			registerCommand: (_id, handler) => { backend = handler; return { dispose() {} }; },
			executeCommand: async (...args) => { calls.push(args); }
		}
	});
	await backend({ action: 'openFolder', id: 'one' });
	assert.deepEqual({ calls, db: await store.load() }, { calls: [['vscode.openFolder', { fsPath: root }, { forceReuseWindow: true }]], db: before });
	await assert.rejects(backend({ action: 'openFolder', id: 'missing' }), /non presente/);
	accounts.assertIdle = async () => { throw new Error('turno attivo'); };
	await assert.rejects(backend({ action: 'openFolder', id: 'one' }), /turno/);
	accounts.assertIdle = async () => {};
	accounts.switching = true;
	await assert.rejects(backend({ action: 'openFolder', id: 'one' }), /Cambio/);
	assert.equal(calls.length, 1);
});

test('blocks busy and concurrent switching without selecting or opening anything', async t => {
	const { store, accounts, service, opened } = await fixture(t);
	accounts.assertIdle = async () => { throw new Error('turno attivo'); };
	await assert.rejects(service.select('one'), /turno/);
	assert.deepEqual({ selections: (await store.load()).selections, opened, switching: accounts.switching }, { selections: {}, opened: [], switching: false });
	accounts.switching = true;
	await assert.rejects(service.select('one'), /cambio/i);
});

test('selects all defaults per folder, keeps other windows defaults and rolls back a failed open', async t => {
	const { root, store, service, accounts, opened } = await fixture(t);
	await store.update(db => { db.selections.other = { id: 'other', accountId: 'b', environmentId: 'f' }; });
	await service.select('one');
	assert.deepEqual(selectedWorkspace(root, root), { id: 'one', accountId: 'a', environmentId: 'e' });
	assert.deepEqual(opened, [root]);
	assert.equal((await store.load()).selections.other.accountId, 'b');
	assert.equal(accounts.current.id, 'previous');
	accounts.switching = false; // Simulate a new host after the window reload.
	await store.update(db => { db.workspaces[0].accountId = 'missing'; });
	await assert.rejects(service.select('one'), /account/i);
	await store.update(db => { db.workspaces[0].accountId = 'a'; db.workspaces[0].environmentId = 'e'; });
	service.open = async () => { throw new Error('open failed'); };
	const before = await store.load();
	await assert.rejects(service.select('one'), /open failed/);
	assert.deepEqual(await store.load(), before);
	assert.equal(accounts.switching, false);
});

test('missing folders and credentials do not commit a selection', async t => {
	const { root, store, service, accounts } = await fixture(t);
	await store.update(db => { db.workspaces[0].folder = path.join(root, 'missing'); });
	await assert.rejects(service.select('one'), /ENOENT/);
	await store.update(db => { db.workspaces[0].folder = root; });
	accounts.authenticate = async () => { throw new Error('Collega un account'); };
	await assert.rejects(service.select('one'), /Collega/);
	assert.deepEqual((await store.load()).selections, {});
});

test('cancelled window navigation restores selection and releases the turn lock', async t => {
	const { service, accounts, store } = await fixture(t);
	t.mock.timers.enable({ apis: ['setTimeout'] });
	await service.select('one');
	assert.equal(accounts.switching, true);
	t.mock.timers.tick(12000);
	await service.reloadRecovery;
	assert.deepEqual({ switching: accounts.switching, selections: (await store.load()).selections }, { switching: false, selections: {} });
	assert.match(service.switchError, /annullato/);
});

test('bootstraps the environment of the folder without changing the global default', async t => {
	const { root, store } = await fixture(t);
	const { EnvironmentStore, applyEnvironment } = require('../../extensions/zilpio-codex/environments.js');
	const environments = new EnvironmentStore(root, root);
	await environments.load();
	await store.update(db => { db.selections[process.platform === 'win32' ? root.toLowerCase() : root] = { id: 'one', accountId: 'a', environmentId: 'codex' }; });
	const env = { ZILPIO_PROFILES_ROOT: root };
	applyEnvironment(env, root, root);
	assert.equal(env.CODEX_HOME, path.join(root, '.codex'));
	assert.equal((await environments.load()).activeProfileId, 'work');
});

test('existing environment selector updates only the folder selection, and rolls it back on reload failure', async t => {
	const { root, store, service, accounts } = await fixture(t);
	const { EnvironmentStore, EnvironmentService } = require('../../extensions/zilpio-codex/environments.js');
	const environments = new EnvironmentStore(root, root);
	await environments.load();
	service.folder = () => root;
	await store.update(db => { db.selections[process.platform === 'win32' ? root.toLowerCase() : root] = { id: 'one', accountId: 'a', environmentId: 'work' }; });
	accounts.workspaces = service;
	const selector = new EnvironmentService(environments, accounts, async () => {});
	await selector.initialize(path.join(root, '.codex-work'));
	await selector.select('codex');
	assert.deepEqual({ selection: selectedWorkspace(root, root).environmentId, global: (await environments.load()).activeProfileId, preset: (await store.load()).workspaces[0].environmentId }, { selection: 'codex', global: 'work', preset: 'e' });
	selector.reload = async () => { throw new Error('reload failed'); };
	await assert.rejects(selector.select('work'), /reload failed/);
	assert.equal(selectedWorkspace(root, root).environmentId, 'codex');
});

test('reads separate account quotas, deduplicates requests, and never changes the working account', async t => {
	const { service, accounts } = await fixture(t);
	const calls = [];
	service.createRpc = (_, home) => ({
		initialize: async () => { calls.push('initialize'); },
		request: async method => { calls.push(method); return { rateLimits: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1234 }, secondary: { usedPercent: 200, windowDurationMins: 10080 } } }; },
		dispose: () => { calls.push('dispose'); }
	});
	const first = service.usage('a');
	assert.equal(service.usage('a'), first);
	const result = await first;
	assert.deepEqual({ calls, percent: result.map(w => w.usedPercent), active: accounts.current.id }, { calls: ['initialize', 'account/rateLimits/read', 'dispose'], percent: [24, 100], active: 'previous' });
	service.createRpc = () => ({ initialize: async () => {}, request: async () => { throw new Error('not signed in'); }, dispose: () => { calls.push('dispose-error'); } });
	await assert.rejects(service.usage('a'), /not signed in/);
	assert.equal(calls.at(-1), 'dispose-error');
});
