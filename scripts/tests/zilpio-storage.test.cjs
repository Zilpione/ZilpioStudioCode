/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-storage-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, 'user'), registry = path.join(root, 'registry');
	await fs.mkdir(home); await fs.mkdir(registry);
	return { root, home, registry };
}

test('authentication helper persists refreshed credentials only and cleans up failed requests', async t => {
	const { withAccountRpc } = require('../../extensions/zilpio-codex/account-auth.js');
	const { home } = await fixture(t);
	const account = { home: path.join(home, '.codex-account', 'work') };
	await fs.mkdir(account.home, { recursive: true });
	await fs.writeFile(path.join(account.home, 'auth.json'), '{"token":"old"}');
	let temporary;
	const createRpc = (_, workerHome, ephemeral) => {
		temporary = workerHome;
		assert.notEqual(workerHome, account.home);
		assert.equal(ephemeral, false);
		assert.equal(sync.readFileSync(path.join(workerHome, 'auth.json'), 'utf8'), '{"token":"old"}');
		sync.writeFileSync(path.join(workerHome, 'state.sqlite'), 'unwanted');
		return { dispose() {}, exited: Promise.resolve() };
	};
	await assert.rejects(withAccountRpc('binary', account, async (_, workerHome) => {
		await fs.writeFile(path.join(workerHome, 'auth.json'), '{"token":"renewed"}');
		throw new Error('request failed after refresh');
	}, createRpc), /request failed/);
	assert.deepEqual(await fs.readdir(account.home), ['auth.json']);
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(account.home, 'auth.json'), 'utf8')), { token: 'renewed' });
	assert.equal(sync.existsSync(temporary), false);
});

test('new accounts and environments have separate homes and reject occupied destinations', async t => {
	const { ProfileStore } = require('../../extensions/zilpio-codex/profiles.js');
	const { EnvironmentStore } = require('../../extensions/zilpio-codex/environments.js');
	const { home, registry } = await fixture(t);
	const accounts = new ProfileStore(registry, [], { userHome: home });
	const account = await accounts.create('Work Account');
	const environments = new EnvironmentStore(registry, home);
	const environment = await environments.create('Test');
	assert.deepEqual([account.home, environment.home], [path.join(home, '.codex-account', 'work-account'), path.join(home, '.codex-test')]);
	await fs.mkdir(path.join(home, '.codex-taken'));
	await fs.writeFile(path.join(home, '.codex-taken', 'keep'), 'data');
	await assert.rejects(environments.create('Taken'), /exist|occup|EEXIST/i);
	assert.equal(await fs.readFile(path.join(home, '.codex-taken', 'keep'), 'utf8'), 'data');
});

async function legacy(t) {
	const f = await fixture(t);
	const original = path.join(f.home, '.codex'), account = path.join(f.home, '.codex-account-work'), environment = path.join(f.home, '.codexchathistory-zscode');
	for (const dir of [original, account, environment]) { await fs.mkdir(dir); }
	await fs.writeFile(path.join(original, 'auth.json'), 'original-auth');
	await fs.writeFile(path.join(account, 'auth.json'), 'account-auth');
	await fs.mkdir(path.join(account, 'skills'));
	await fs.writeFile(path.join(environment, 'state.sqlite'), 'environment-data');
	await fs.writeFile(path.join(f.registry, 'profiles.json'), JSON.stringify({ version: 1, activeProfileId: 'work', profiles: [{ id: 'work', name: 'Work', provider: 'openai', home: account }, { id: 'default', name: 'Default', provider: 'openai', home: original }] }));
	await fs.writeFile(path.join(f.registry, 'environments.json'), JSON.stringify({ version: 1, activeProfileId: 'work', profiles: [{ id: 'work', name: 'Work', provider: 'openai', home: environment }, { id: 'codex', name: 'Codex', provider: 'openai', home: original }] }));
	return { ...f, original, account, environment };
}

test('migration preserves IDs, moves environment, copies only account auth and is retry safe', async t => {
	const { migrateStorage } = require('../../extensions/zilpio-codex/storage-migration.js');
	const f = await legacy(t);
	migrateStorage(f.registry, f.home);
	const read = file => JSON.parse(sync.readFileSync(path.join(f.registry, file), 'utf8'));
	assert.deepEqual(read('profiles.json').profiles.map(p => [p.id, p.home]), [['work', path.join(f.home, '.codex-account', 'work')], ['default', path.join(f.home, '.codex-account', 'default')]]);
	assert.deepEqual(read('environments.json').profiles.map(p => [p.id, p.home]), [['work', path.join(f.home, '.codex-work')], ['codex', f.original]]);
	assert.deepEqual(await fs.readdir(path.join(f.home, '.codex-account', 'work')), ['auth.json']);
	assert.deepEqual(await fs.readdir(path.join(f.home, '.codex-work')), ['state.sqlite']);
	assert.equal(await fs.readFile(path.join(f.original, 'auth.json'), 'utf8'), 'original-auth');
	assert.equal(sync.existsSync(f.environment), false);
	await fs.writeFile(path.join(f.home, '.codex-account', 'work', 'auth.json'), 'updated-auth');
	migrateStorage(f.registry, f.home);
	assert.equal(await fs.readFile(path.join(f.home, '.codex-account', 'work', 'auth.json'), 'utf8'), 'updated-auth');
});

test('migration rejects conflicting destinations before changing registries or source data', async t => {
	const { migrateStorage } = require('../../extensions/zilpio-codex/storage-migration.js');
	const f = await legacy(t);
	await fs.mkdir(path.join(f.home, '.codex-work'));
	const before = await fs.readFile(path.join(f.registry, 'profiles.json'), 'utf8');
	assert.throws(() => migrateStorage(f.registry, f.home), /exist|esist|occup|conflitt/i);
	assert.equal(await fs.readFile(path.join(f.registry, 'profiles.json'), 'utf8'), before);
	assert.equal(await fs.readFile(path.join(f.environment, 'state.sqlite'), 'utf8'), 'environment-data');
});

test('managed environments reject persisted credentials while original Codex keeps its login', async t => {
	const { EnvironmentStore, applyEnvironment } = require('../../extensions/zilpio-codex/environments.js');
	const { home, registry } = await fixture(t);
	const store = new EnvironmentStore(registry, home);
	await store.load();
	await fs.mkdir(path.join(home, '.codex-work'));
	await fs.writeFile(path.join(home, '.codex-work', 'auth.json'), 'unexpected');
	assert.throws(() => applyEnvironment({ ZILPIO_PROFILES_ROOT: registry }, home), /auth.json/);
	await store.select('codex');
	await fs.mkdir(path.join(home, '.codex'));
	await fs.writeFile(path.join(home, '.codex', 'auth.json'), 'original');
	assert.doesNotThrow(() => applyEnvironment({ ZILPIO_PROFILES_ROOT: registry }, home));
});

test('a partial registry commit resumes without moving or replacing the environment twice', async t => {
	const { migrateStorage } = require('../../extensions/zilpio-codex/storage-migration.js');
	const f = await legacy(t);
	const rename = sync.renameSync;
	sync.renameSync = (from, to) => {
		if (to === path.join(f.registry, 'environments.json')) { throw new Error('simulated registry failure'); }
		return rename(from, to);
	};
	try { assert.throws(() => migrateStorage(f.registry, f.home), /simulated/); }
	finally { sync.renameSync = rename; }
	migrateStorage(f.registry, f.home);
	assert.equal(await fs.readFile(path.join(f.home, '.codex-work', 'state.sqlite'), 'utf8'), 'environment-data');
	assert.equal(JSON.parse(await fs.readFile(path.join(f.registry, 'storage-migration.json'), 'utf8')).phase, 'complete');
});

test('migration can resume a registry failure when an old environment directory is absent', async t => {
	const { migrateStorage } = require('../../extensions/zilpio-codex/storage-migration.js');
	const f = await legacy(t);
	await fs.rm(f.environment, { recursive: true });
	const rename = sync.renameSync;
	sync.renameSync = (from, to) => {
		if (to === path.join(f.registry, 'environments.json')) { throw new Error('simulated registry failure'); }
		return rename(from, to);
	};
	try { assert.throws(() => migrateStorage(f.registry, f.home), /simulated/); }
	finally { sync.renameSync = rename; }
	assert.doesNotThrow(() => migrateStorage(f.registry, f.home));
	assert.equal(JSON.parse(await fs.readFile(path.join(f.registry, 'environments.json'), 'utf8')).profiles[0].home, path.join(f.home, '.codex-work'));
});

test('migration relocates rollout indexes and configuration paths without changing project paths', async t => {
	const { DatabaseSync } = require('node:sqlite');
	const { migrateStorage } = require('../../extensions/zilpio-codex/storage-migration.js');
	const f = await legacy(t);
	const file = path.join(f.environment, 'state_5.sqlite');
	const db = new DatabaseSync(file);
	db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
	db.prepare('INSERT INTO threads VALUES (?, ?)').run('one', path.join(f.environment, 'sessions', 'chat.jsonl'));
	db.prepare('INSERT INTO threads VALUES (?, ?)').run('outside', path.join(f.home, 'project', 'chat.jsonl'));
	db.close();
	await fs.writeFile(path.join(f.environment, 'config.toml'), `skills_path = '${path.join(f.environment, 'skills')}'`);
	migrateStorage(f.registry, f.home);
	const moved = new DatabaseSync(path.join(f.home, '.codex-work', 'state_5.sqlite'));
	try {
		assert.deepEqual(moved.prepare('SELECT id, rollout_path FROM threads ORDER BY id').all().map(row => [row.id, row.rollout_path]), [['one', path.join(f.home, '.codex-work', 'sessions', 'chat.jsonl')], ['outside', path.join(f.home, 'project', 'chat.jsonl')]]);
	} finally { moved.close(); }
	assert.equal(await fs.readFile(path.join(f.home, '.codex-work', 'config.toml'), 'utf8'), `skills_path = '${path.join(f.home, '.codex-work', 'skills')}'`);
});

test('relocation is retry safe when the target begins with the old environment name', async t => {
	const { relocateEnvironmentPaths } = require('../../extensions/zilpio-codex/storage-migration.js');
	const { home } = await fixture(t);
	const source = path.join(home, '.codex-foo'), target = path.join(home, '.codex-foo-archive');
	await fs.mkdir(target);
	await fs.writeFile(path.join(target, 'config.toml'), `skills = '${path.join(source, 'skills')}'\nother = '${source}-backup'`);
	relocateEnvironmentPaths(target, source, target);
	relocateEnvironmentPaths(target, source, target);
	assert.equal(await fs.readFile(path.join(target, 'config.toml'), 'utf8'), `skills = '${path.join(target, 'skills')}'\nother = '${source}-backup'`);
});

test('migration rebases agent homes and retains names, IDs and project ownership', async t => {
	const { migrateStorage } = require('../../extensions/zilpio-codex/storage-migration.js');
	const { AgentStore } = require('../../extensions/zilpio-codex/agents.js');
	const f = await legacy(t);
	const store = new AgentStore(f.registry);
	const agent = await store.create({ threadId: 'same-thread', home: f.environment, project: f.home, name: 'StorageTest' });
	migrateStorage(f.registry, f.home);
	assert.deepEqual((await store.load()).agents, [{ ...agent, home: path.join(f.home, '.codex-work') }]);
});

test('concurrent helpers serialize refreshes for the same account', async t => {
	const { withAccountRpc } = require('../../extensions/zilpio-codex/account-auth.js');
	const { home } = await fixture(t);
	const account = { home: path.join(home, '.codex-account', 'work') };
	const create = () => ({ dispose() {}, exited: Promise.resolve() });
	const values = [];
	await Promise.all([1, 2].map(value => withAccountRpc('binary', account, async (_, temporary) => {
		let prior;
		try { prior = JSON.parse(await fs.readFile(path.join(temporary, 'auth.json'), 'utf8')).value; }
		catch (error) { if (error.code !== 'ENOENT') { throw error; } }
		values.push(prior ?? 0);
		await fs.writeFile(path.join(temporary, 'auth.json'), JSON.stringify({ value }));
	}, create)));
	assert.deepEqual(values, [0, 1]);
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(account.home, 'auth.json'), 'utf8')), { value: 2 });
});

test('native Codex login persists only account auth and keeps environment login ephemeral', { timeout: 25000 }, async t => {
	const binary = path.resolve(__dirname, '../../.build/clean-host/2a59476c9b/resources/app/extensions/openai.chatgpt/bin/windows-x86_64/codex.exe');
	if (!sync.existsSync(binary)) { t.skip('Bundled Codex binary unavailable'); return; }
	const { withAccountRpc } = require('../../extensions/zilpio-codex/account-auth.js');
	const { readAuthentication } = require('../../extensions/zilpio-codex/backend.js');
	const { startRpc } = require('../../extensions/zilpio-codex/rpc.js');
	const { home } = await fixture(t);
	const account = { home: path.join(home, '.codex-account', 'test') };
	await withAccountRpc(binary, account, async worker => {
		await worker.initialize();
		await worker.request('account/login/start', { type: 'apiKey', apiKey: 'sk-local-storage-test' });
	});
	assert.deepEqual(await fs.readdir(account.home), ['auth.json']);
	const auth = await readAuthentication(binary, account);
	assert.deepEqual(auth, { type: 'apiKey', apiKey: 'sk-local-storage-test' });
	const environment = path.join(home, '.codex-test');
	await fs.mkdir(environment);
	const worker = startRpc(binary, environment, true);
	try {
		await worker.initialize();
		await worker.request('account/login/start', auth);
		assert.equal((await worker.request('account/read', { refreshToken: false })).account.type, 'apiKey');
	} finally { worker.dispose(); await worker.exited; }
	assert.equal(sync.existsSync(path.join(environment, 'auth.json')), false);
	assert.deepEqual(await fs.readdir(account.home), ['auth.json']);
});

test('native Codex reopens the same thread after its environment moves', { timeout: 25000 }, async t => {
	const binary = path.resolve(__dirname, '../../.build/clean-host/2a59476c9b/resources/app/extensions/openai.chatgpt/bin/windows-x86_64/codex.exe');
	if (!sync.existsSync(binary)) { t.skip('Bundled Codex binary unavailable'); return; }
	const { startRpc } = require('../../extensions/zilpio-codex/rpc.js');
	const { migrateStorage } = require('../../extensions/zilpio-codex/storage-migration.js');
	const { home, registry } = await fixture(t);
	const source = path.join(home, '.codexchathistory-zscode'), target = path.join(home, '.codex-work');
	await fs.mkdir(source);
	await fs.writeFile(path.join(registry, 'profiles.json'), JSON.stringify({ version: 1, activeProfileId: null, profiles: [] }));
	await fs.writeFile(path.join(registry, 'environments.json'), JSON.stringify({ version: 1, activeProfileId: 'work', profiles: [{ id: 'work', name: 'Work', provider: 'openai', home: source }] }));
	const server = require('node:http').createServer((req, res) => {
		if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
		req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' });
		const item = { id: 'msg_local', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'local migration reply', annotations: [] }] };
		for (const event of [{ type: 'response.created', response: { id: 'resp_local' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_local', status: 'completed', output: [item] } }]) {
			res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		}
		res.end();
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	let worker = startRpc(binary, source, true), id;
	try {
		await worker.initialize();
		await worker.request('account/login/start', { type: 'apiKey', apiKey: 'sk-local-migration-test' });
		const result = await worker.request('thread/start', { cwd: home, model: 'gpt-5.4', modelProvider: 'storage-local', config: { 'model_providers.storage-local.name': 'Local storage test', 'model_providers.storage-local.base_url': `http://127.0.0.1:${server.address().port}/v1`, 'model_providers.storage-local.wire_api': 'responses', 'model_providers.storage-local.supports_websockets': false, 'model_providers.storage-local.requires_openai_auth': true }, approvalPolicy: 'never', sandbox: 'read-only', persistExtendedHistory: true });
		id = result.thread.id;
		const completed = new Promise((resolve, reject) => {
			worker.on('notification', (method, params) => { if (method === 'turn/completed' && params.threadId === id) { params.turn.error ? reject(new Error(params.turn.error.message)) : resolve(); } });
		});
		completed.catch(() => {});
		await worker.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Local storage migration test' }] });
		await completed;
		await worker.request('thread/unsubscribe', { threadId: id });
	} finally { worker.dispose(); await worker.exited; }
	migrateStorage(registry, home);
	worker = startRpc(binary, target, true);
	try {
		await worker.initialize();
		await worker.request('account/login/start', { type: 'apiKey', apiKey: 'sk-local-migration-test' });
		const result = await worker.request('thread/read', { threadId: id, includeTurns: false });
		assert.equal(result.thread.id, id);
		assert.ok(result.thread.path.toLowerCase().startsWith(target.toLowerCase()));
	} finally { worker.dispose(); await worker.exited; }
});
