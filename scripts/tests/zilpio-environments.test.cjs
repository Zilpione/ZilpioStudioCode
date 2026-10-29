const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EnvironmentStore, EnvironmentService, applyEnvironment } = require('../../extensions/zilpio-codex/environments.js');

test('seeds Work and Codex, persists selection and editable nicknames, and resolves the runtime home', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-env-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, 'user');
	const store = new EnvironmentStore(root, home);
	const db = await store.load();
	assert.deepEqual(db.profiles.map(p => [p.id, p.name, p.home]), [
		['work', 'Work', path.join(home, '.codex-work')], ['codex', 'Codex', path.join(home, '.codex')]
	]);
	const env = { ZILPIO_PROFILES_ROOT: root, CODEX_HOME: '/inherited' };
	applyEnvironment(env, home);
	assert.equal(env.CODEX_HOME, db.profiles[0].home);
	await store.select('codex');
	const edited = await store.load(); edited.profiles[1].name = 'Personale';
	await fs.writeFile(store.file, JSON.stringify(edited));
	applyEnvironment(env, home);
	assert.equal(env.CODEX_HOME, path.join(home, '.codex'));
	assert.equal((await new EnvironmentStore(root, home).load()).profiles[1].name, 'Personale');
	edited.profiles[1].home = 'relative'; await fs.writeFile(store.file, JSON.stringify(edited));
	assert.throws(() => applyEnvironment(env, home), /absolute/);
});

test('switches history only when idle, preserves account choice, and rolls back a failed reload', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-env-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const store = new EnvironmentStore(root, root);
	const accounts = { switching: false, current: { id: 'account-a' }, assertIdle: async () => {} };
	let reloads = 0;
	const service = new EnvironmentService(store, accounts, async () => { reloads++; });
	await service.initialize(path.join(root, '.codex-work'));
	accounts.assertIdle = async () => { throw new Error('turno attivo'); };
	await assert.rejects(service.select('codex'), /turno/);
	assert.equal((await store.load()).activeProfileId, 'work');
	accounts.assertIdle = async () => {};
	await service.select('codex');
	assert.equal(reloads, 1);
	assert.equal(accounts.current.id, 'account-a');
	assert.equal((await service.list()).activeEnvironmentId, 'codex');
	service.startupError = 'Invalid environment selection at startup';
	await service.select('codex');
	assert.equal(reloads, 2, 'Repairing startup settings must reload even when the home is unchanged');
	assert.equal(service.startupError, undefined);
	service.reload = async () => { throw new Error('reload failed'); };
	await assert.rejects(service.select('work'), /reload failed/);
	assert.equal((await store.load()).activeProfileId, 'codex');
	assert.equal(accounts.switching, false);
});

test('official host waits for sidebar reset and closes conversation editors before reloading', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-env-host-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const vm = require('node:vm');
	const filename = require.resolve('../../extensions/zilpio-codex/environments.js');
	const localRequire = require('node:module').createRequire(filename);
	const loaded = { exports: {} }, calls = [], messages = [], webview = {};
	let service;
	vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
		module: loaded, process: { env: { ZILPIO_PROFILES_ROOT: root, CODEX_HOME: path.join(os.homedir(), '.codex-work') } }, setTimeout, clearTimeout,
		require: name => name === 'vscode' ? {
			commands: { executeCommand: async command => calls.push(command) },
			workspace: { onDidSaveTextDocument: () => ({ dispose() {} }) },
			window: { showErrorMessage: message => assert.fail(message) }
		} : localRequire(name)
	});
	const owner = {
		subscriptions: [], sidebarView: { webview }, sidebarWebviewReady: true,
		editorPanels: new Map([[{ dispose: () => calls.push('dispose-chat-editor') }, {}]]),
		broadcastToAllViews: message => messages.push(message),
		postMessageToWebview: (_, message) => {
			if (message.type !== 'zilpio-environments-reset') { return; }
			calls.push('reset-sidebar');
			setImmediate(async () => {
				await service.handle({}, { action: 'reset-complete', requestId: message.requestId });
				assert.equal(calls.includes('workbench.action.reloadWindow'), false);
				await service.handle(webview, { action: 'reset-complete', requestId: message.requestId });
			});
		}
	};
	service = loaded.exports.create(owner, { switching: false, assertIdle: async () => {} });
	await service.handle(webview, { action: 'select', environmentId: 'codex' });
	assert.deepEqual(calls, ['chatgpt.newChat', 'reset-sidebar', 'dispose-chat-editor', 'workbench.action.reloadWindow']);
	assert.equal(messages[0].activeEnvironmentId, 'codex');
	assert.equal((await service.store.load()).activeProfileId, 'codex');
	assert.equal(owner.subscriptions.length, 1);
});
