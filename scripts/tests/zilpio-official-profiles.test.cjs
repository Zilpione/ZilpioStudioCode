const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { OfficialProfiles } = require('../../extensions/zilpio-codex/official-profiles.js');

function setup() {
	let active = 'a'; const log = [];
	const profiles = [{ id: 'a', name: 'A', home: '/a', provider: 'openai' }, { id: 'b', name: 'B', home: '/b', provider: 'openai' }];
	const store = { load: async () => ({ activeProfileId: active, profiles }), select: async id => { active = id; } };
	const service = new OfficialProfiles({ store, authenticate: async (_, p) => ({ type: 'apiKey', apiKey: 'secret-' + p.id }), binary: async () => '/codex', request: async (method, params) => { log.push({ method, params }); if (method === 'thread/loaded/list') { return { data: [] }; } return {}; } });
	return { service, log, store };
}

test('records settings only after a user prompt is accepted, excluding rejected and delegated turns', async () => {
	const { service } = setup(); const saved = [];
	service.startup = { record: async snapshot => saved.push(snapshot) };
	service.project = '/project'; service.environmentId = 'env'; service.current = { id: 'a' };
	service.trackPrompt('rejected', { model: 'gpt-6-astra', input: 'private' });
	service.receive({ id: 'rejected', error: { message: 'rejected' } });
	service.receive({ id: 'delegated', result: {} });
	assert.deepEqual(saved, []);
	service.trackPrompt('accepted', { model: 'gpt-6-luna', effort: 'high', serviceTier: 'default', input: 'private' });
	service.receive({ id: 'accepted', result: {} }); await service.startupSaved;
	assert.deepEqual(saved, [{ project: '/project', accountId: 'a', environmentId: 'env', params: { model: 'gpt-6-luna', effort: 'high', serviceTier: 'default', collaborationMode: undefined } }]);
});

test('confirms every Astra send and only Speed sends for Sol, excluding Luna', async () => {
	const { service } = setup(); const prompts = [];
	service.confirm = async model => { prompts.push(model); return true; };
	const cases = [
		['gpt-6-astra', null, 'astra'], ['gpt-6-astra', 'fast', 'astra'],
		['gpt-6-astra', 'ultrafast', 'astra'], ['gpt-6.1-sol', 'fast', 'sol'],
		['gpt-6.1-sol', 'priority', 'sol'], ['gpt-6-sol', 'priority', 'sol'],
		['gpt-6-astra', 'priority', 'astra'], ['gpt-6-luna', 'priority', null],
		['gpt-6.1-sol', 'ultrafast', 'sol'], ['gpt-6.1-sol', 'standard', null],
		['gpt-6.1-sol', null, null], ['gpt-6-luna', 'fast', null],
		['gpt-6-luna', 'ultrafast', null], ['gpt-6-luna', null, null],
		['other-model', 'fast', null], ['solaris', 'fast', null]
	];
	for (const [model, serviceTier] of cases) { assert.equal(await service.confirmTurn({ model, serviceTier }), true); }
	await service.confirmTurn({ model: 'gpt-6-astra' });
	assert.deepEqual(prompts, [...cases.flatMap(([, , prompt]) => prompt ? [prompt] : []), 'astra']);
});

test('uses the collaboration model and cancels sends when the popup is dismissed', async () => {
	const { service } = setup(); const prompts = [];
	service.confirm = async model => { prompts.push(model); return false; };
	const results = await Promise.all([
		service.confirmTurn({ model: 'gpt-6-luna', collaborationMode: { settings: { model: 'gpt-6-astra' } } }),
		service.confirmTurn({ model: 'gpt-6-astra', collaborationMode: { settings: { model: 'gpt-6-luna' } }, serviceTier: 'fast' }),
		service.confirmTurn({ model: 'gpt-6.1-sol', serviceTier: 'fast' }),
		service.confirmTurn({})
	]);
	assert.deepEqual({ results, prompts }, { results: [false, true, false, true], prompts: ['astra', 'sol'] });
});

test('the official host waits for confirmation and never forwards a cancelled turn', async () => {
	const patch = fs.readFileSync(require.resolve('../patch-official-codex.cjs'), 'utf8');
	const line = patch.split('\n').find(line => line.startsWith("replaceOnce('this.zilpioProfiles.pendingTurnStarts.set"));
	let guard;
	vm.runInNewContext(line, { replaceOnce: (_, replacement) => { guard = replacement; } });
	const forwarded = [], replies = [];
	const handle = vm.runInNewContext(`(async function(e,r){switch(r.type){case 'mcp-request': if(r.request.method==='turn/start'&&this.zilpioProfiles) ${guard.replace('if(SK(r.request))', '')} forwarded.push(r.request);}})`, { forwarded });
	const { service } = setup(); service.current = { id: 'a' };
	const owner = { zilpioProfiles: service, postMessageToWebview: (_, message) => replies.push(message) };
	const message = { type: 'mcp-request', hostId: 'local', request: { id: 'send', method: 'turn/start', params: { threadId: 'thread', model: 'gpt-6-astra' } } };
	let answer;
	service.confirm = () => new Promise(resolve => { answer = resolve; });
	const pending = handle.call(owner, {}, message);
	assert.deepEqual([forwarded.length, service.pendingTurnStarts.size], [0, 1]);
	await assert.rejects(service.switch('b'), /turno/);
	answer(false); await pending;
	assert.deepEqual([forwarded.length, service.pendingTurnStarts.size, replies[0].message.id, replies[0].hostId, replies[0].message.error.message], [0, 0, 'send', 'local', 'Invio annullato.']);
	service.confirm = async () => true;
	await handle.call(owner, {}, message);
	assert.equal(forwarded.length, 1);
	service.receive({ id: 'send', error: { message: 'test completed' } });
	service.confirm = async () => { throw new Error('Dialog closed'); };
	await handle.call(owner, {}, message);
	assert.deepEqual([forwarded.length, service.pendingTurnStarts.size, replies[1].message.error.message], [1, 0, 'Dialog closed']);
	await handle.call(owner, {}, { type: 'mcp-request', request: { method: 'model/list', params: {} } });
	assert.equal(forwarded.length, 2);
});
test('changes native authentication without starting, resuming or restarting a thread', async () => {
	const { service, log } = setup();
	await service.switch('b');
	assert.deepEqual(log.map(x => x.method), ['thread/loaded/list', 'account/login/start']);
	assert.equal((await service.list()).activeProfileId, 'b');
	assert.equal(JSON.stringify(await service.list()).includes('secret-'), false);
});
test('rejects switching during a turn and retains the old profile after failed auth', async () => {
	const { service } = setup(); await service.switch('a');
	service.notification('turn/started', { threadId: 'thread' });
	await assert.rejects(service.switch('b'), /turno/);
	service.notification('turn/completed', { threadId: 'thread' });
	service.authenticate = async () => { throw new Error('missing login'); };
	await assert.rejects(service.switch('b'), /missing login/);
	assert.equal((await service.list()).activeProfileId, 'a');
});

test('blocks switching while turn/start is pending and releases a rejected start', async () => {
	const { service } = setup();
	service.pendingTurnStarts.set('request', 'thread');
	await assert.rejects(service.switch('b'), /turno/);
	service.receive({ id: 'request', error: { message: 'start rejected' } });
	await service.switch('b');
	service.pendingTurnStarts.set('request2', 'thread');
	service.receive({ id: 'request2', result: {} });
	await assert.rejects(service.switch('a'), /turno/);
});

test('workspace bootstrap authenticates without overwriting another window default', async () => {
	const { service, store } = setup();
	await service.switch('b', false);
	assert.deepEqual({ active: service.current.id, default: (await store.load()).activeProfileId }, { active: 'b', default: 'a' });
});

test('a fatal transport reset clears activity but authoritative thread state still blocks switching', async () => {
	const { service } = setup();
	service.pendingTurnStarts.set('lost-request', 'thread'); service.activeTurns.add('old-thread');
	service.resetActivity();
	service.request = async method => method === 'thread/loaded/list' ? { data: ['thread'] } : { thread: { status: { type: 'active' } } };
	await assert.rejects(service.switch('b'), /turno/);
	assert.deepEqual([service.pendingTurnStarts.size, service.activeTurns.size], [0, 0]);
});

test('manual account changes persist in the folder selection without changing global defaults', async () => {
	const { service, store } = setup(); const changes = [];
	service.workspaces = { color: async () => null, persistSelection: async (field, id) => { changes.push([field, id]); return true; } };
	await service.switch('b');
	assert.deepEqual({ changes, current: service.current.id, global: (await store.load()).activeProfileId }, { changes: [['accountId', 'b']], current: 'b', global: 'a' });
});
test('rolls native authentication back when registry persistence fails', async () => {
	const { service, log, store } = setup(); await service.switch('a');
	store.select = async () => { throw new Error('disk full'); };
	await assert.rejects(service.switch('b'), /disk full/);
	assert.deepEqual(log.filter(x => x.method === 'account/login/start').map(x => x.params.apiKey), ['secret-a', 'secret-b', 'secret-a']);
});
test('clears external ChatGPT auth for API login and restores ChatGPT after a failed API login', async () => {
	const { service, store } = setup(); const calls = []; let mode = null, failApi = false;
	service.authenticate = async (_, profile) => profile.id === 'a' ? { type: 'chatgptAuthTokens', accessToken: 'token', chatgptAccountId: 'account' } : { type: 'apiKey', apiKey: 'key' };
	service.request = async (method, params) => {
		calls.push({ method, type: params?.type });
		if (method === 'thread/loaded/list') { return { data: [] }; }
		if (method === 'account/logout') { mode = null; return {}; }
		if (method === 'account/login/start') {
			if (mode === 'chatgptAuthTokens' && params.type === 'apiKey') { throw new Error('External auth is active. Use account/logout to clear it.'); }
			if (params.type === 'apiKey' && failApi) { throw new Error('API login failed'); }
			mode = params.type;
		}
		return {};
	};
	await service.switch('a'); calls.length = 0;
	await service.switch('b');
	assert.equal(mode, 'apiKey'); assert.equal((await service.list()).activeProfileId, 'b');
	assert.deepEqual(calls.map(c => c.method), ['thread/loaded/list', 'account/login/start', 'account/logout', 'account/login/start']);
	await service.switch('a'); failApi = true;
	await assert.rejects(service.switch('b'), /API login failed/);
	assert.equal(mode, 'chatgptAuthTokens'); assert.equal((await service.list()).activeProfileId, 'a');
	failApi = false; await service.switch('b');
	store.select = async () => { throw new Error('disk full'); };
	await assert.rejects(service.switch('a'), /disk full/);
	assert.equal(mode, 'apiKey'); assert.equal((await service.list()).activeProfileId, 'b');
});

test('accepts an account chosen in the webview without opening the top QuickPick', async () => {
	const filename = require.resolve('../../extensions/zilpio-codex/official-profiles.js');
	const loaded = { exports: {} };
	const localRequire = require('node:module').createRequire(filename);
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
		module: loaded, process: { env: { ZILPIO_PROFILES_ROOT: require('node:path').resolve('.') } }, setTimeout, clearTimeout,
		require: name => name === 'vscode' ? { workspace: {}, commands: { registerCommand: () => ({ dispose() {} }) }, window: { showQuickPick: () => assert.fail('Account selection must stay inside the webview'), showErrorMessage: message => assert.fail(message) } } : localRequire(name)
	});
	const messages = [];
	const service = loaded.exports.create({ subscriptions: [], broadcastToAllViews: message => messages.push(message) }, () => {}, () => '/codex');
	service.store = setup().store;
	const selected = [];
	service.switch = async id => { selected.push(id); service.current = { id }; };
	await service.handle({}, { action: 'select', profileId: 'b' });
	assert.deepEqual(selected, ['b']);
	assert.equal(messages[0].activeProfileId, 'b');
});
