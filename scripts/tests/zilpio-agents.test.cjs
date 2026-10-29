/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentStore, AgentRouter } = require('../../extensions/zilpio-codex/agents.js');

async function setup(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-agents-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return new AgentStore(root);
}
test('unique generated names, edits, retired references and persistence preserve chat identity', async t => {
	const store = await setup(t), home = path.join(store.root, 'home');
	const [a, b] = await Promise.all([store.create({ threadId: 'one', home, name: 'Primo' }), store.create({ threadId: 'two', home, name: 'Secondo' })]);
	assert.notEqual(a.name, b.name);
	assert.match(a.color, /^#[0-9a-f]{6}$/i);
	const generated = await store.create({ threadId: 'generated', home }); assert.notEqual(generated.name, a.name); assert.notEqual(generated.name, b.name);
	await assert.rejects(store.create({ threadId: 'three', home, name: a.name.toUpperCase() }), /nome/i);
	await assert.rejects(store.create({ threadId: 'one', home }), /chat/i);
	const renamed = await store.edit(a.id, { name: 'OrioneTest', color: '#123abc' });
	assert.deepEqual({ id: renamed.id, threadId: renamed.threadId, color: renamed.color }, { id: a.id, threadId: 'one', color: '#123abc' });
	await assert.rejects(store.edit(b.id, { name: a.name }), /nome/i);
	await assert.rejects(store.edit(a.id, { color: 'red;display:none' }), /colore/i);
	await store.remove(a.id);
	assert.equal((await new AgentStore(store.root).load()).agents.some(agent => agent.id === a.id), false);
	await assert.rejects(store.create({ threadId: 'one', home, name: 'OrioneTest' }), /nome/i);
});
test('invalid and corrupt registries fail without being overwritten', async t => {
	const store = await setup(t);
	await fs.writeFile(store.file, '{invalid');
	await assert.rejects(store.load());
	assert.equal(await fs.readFile(store.file, 'utf8'), '{invalid');
});
test('router queues work, forwards one result and rejects removed, self or foreign targets', async t => {
	const store = await setup(t), home = path.join(store.root, 'home');
	const agent = await store.create({ threadId: 'worker', home, name: 'Elio' });
	const calls = [], active = new Set(['worker']);
	const router = new AgentRouter({ store, home, busy: id => active.has(id), request: async (method, params) => {
		calls.push({ method, params });
		return method === 'thread/read' ? { thread: { id: params.threadId, status: { type: active.has(params.threadId) ? 'active' : 'idle' } } } : { turn: { id: 'turn-' + params.threadId } };
	} });
	assert.equal((await router.send('boss', agent.id, 'Controlla gli errori')).status, 'queued');
	assert.equal(calls.some(c => c.method === 'turn/start'), false);
	active.delete('worker');
	await router.completed('worker', { id: 'previous', status: 'completed' });
	assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
	router.message('worker', 'turn-worker', 'Risultato verificato');
	await router.completed('worker', { id: 'turn-worker', status: 'completed' });
	assert.equal(calls.filter(c => c.method === 'turn/start').length, 2);
	assert.match(calls.at(-1).params.input[0].text, /Risultato verificato/);
	await router.completed('boss', { id: 'turn-boss', status: 'completed' });
	assert.equal(calls.filter(c => c.method === 'turn/start').length, 2);
	await assert.rejects(router.send('worker', agent.id, 'loop'), /stessa chat/i);
	const foreign = await store.create({ threadId: 'foreign', home: path.join(store.root, 'other'), name: 'Altro' });
	await assert.rejects(router.send('boss', foreign.id, 'test'), /environment/i);
	active.add('worker');
	await router.send('boss', agent.id, 'queued');
	await store.remove(agent.id); active.delete('worker');
	await router.completed('worker', { id: 'previous', status: 'completed' });
	assert.equal(calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'worker').length, 1);
	await assert.rejects(router.send('boss', agent.id, 'gone'), /agente/i);
});
test('concurrent assignments start one turn and stale completion cannot release its successor', async t => {
	const store = await setup(t), home = path.join(store.root, 'home'), starts = [];
	const agent = await store.create({ threadId: 'worker', home });
	const router = new AgentRouter({ store, home, request: async (method, params) => {
		if (method === 'thread/read') { return { thread: { status: { type: 'idle' } } }; }
		starts.push(params); return { turn: { id: `turn-${starts.length}` } };
	} });
	const deliveries = await Promise.all([router.send('boss', agent.id, 'first'), router.send('boss', agent.id, 'second')]);
	assert.deepEqual(deliveries.map(d => d.status).sort(), ['queued', 'sent']);
	assert.equal(starts.length, 1);
	const firstMessage = router.running.get('worker').message;
	await router.completed('worker', { id: 'turn-1', status: 'completed' });
	assert.equal(starts.filter(s => s.threadId === 'worker').length, 2);
	await router.completed('worker', { id: 'turn-1', status: 'completed' });
	assert.notEqual(router.running.get('worker').message, firstMessage);
	assert.equal(router.hasPendingWork, true); router.reset(); assert.equal(router.hasPendingWork, false);
});
test('local MCP credentials bind the sender and reject unbound keys and browser origins', async t => {
	const store = await setup(t), home = path.join(store.root, 'home');
	const before = { root: process.env.ZILPIO_PROFILES_ROOT, home: process.env.CODEX_HOME };
	process.env.ZILPIO_PROFILES_ROOT = store.root; process.env.CODEX_HOME = home;
	const calls = [], accounts = { current: { id: 'test' }, pendingTurnStarts: new Map(), activeTurns: new Set(), bootstrap: async () => {}, request: async (method, params) => {
		calls.push({ method, params }); return method === 'thread/read' ? { thread: { status: { type: 'idle' } } } : { turn: { id: 'turn' } };
	} };
	const service = require('../../extensions/zilpio-codex/agents.js').create({ subscriptions: [], broadcastToAllViews() {} }, accounts, { workspace: { workspaceFolders: [{ uri: { fsPath: home } }] } });
	t.after(() => { service.dispose(); if (before.root === undefined) { delete process.env.ZILPIO_PROFILES_ROOT; } else { process.env.ZILPIO_PROFILES_ROOT = before.root; } if (before.home === undefined) { delete process.env.CODEX_HOME; } else { process.env.CODEX_HOME = before.home; } });
	const params = await service.prepareRequest('thread/start', { config: { 'existing.setting': true } }, 'start');
	assert.equal(params.config['existing.setting'], true);
	const [, endpoint, key] = params.config['mcp_servers.zilpio_agents'].args;
	const post = (authorization, origin) => fetch(endpoint, { method: 'POST', headers: { authorization, ...(origin ? { origin } : {}) }, body: JSON.stringify({ action: 'list' }) });
	assert.equal((await post(key)).status, 403);
	service.receive({ id: 'start', result: { thread: { id: 'boss' } } });
	assert.equal((await post(key, 'http://example.test')).status, 403);
	assert.equal((await post('wrong-key')).status, 403);
	assert.equal((await post(key)).status, 200);
	const agent = await service.store.create({ home, project: home, threadId: 'worker', name: 'Elio' });
	const result = await require('../../extensions/zilpio-codex/agents-mcp.js').handle({ method: 'tools/call', params: { name: 'send_message', arguments: { recipient: agent.id, message: 'Authorized work' } } }, endpoint, key);
	assert.equal(result.isError, false); assert.equal(JSON.parse(result.content[0].text).status, 'sent');
	assert.equal(service.router.running.get('worker').source, 'boss');
});
test('a full work queue still retains mandatory results for a busy orchestrator', async t => {
	const store = await setup(t), home = path.join(store.root, 'home');
	const agent = await store.create({ home, threadId: 'worker' });
	const router = new AgentRouter({ store, home, busy: id => id !== 'worker', request: async method => method === 'thread/read' ? { thread: { status: { type: 'idle' } } } : { turn: { id: 'turn' } } });
	await router.send('boss', agent.id, 'work');
	for (let i = 0; i < 64; i++) { router.enqueue('busy', { id: String(i), message: 'queued work' }); }
	await router.completed('worker', { id: 'turn', status: 'completed' });
	assert.equal(router.queues.get('boss').length, 1);
	assert.equal(router.queues.get('boss')[0].reply, true);
});
test('agents are scoped to exact project roots and names address the existing chat', async t => {
	const store = await setup(t), home = path.join(store.root, 'home'), project = path.join(store.root, 'project');
	const agentone = await store.create({ home, project, threadId: 'agentone', name: 'AgentOne' });
	const agenttwo = await store.create({ home, project, threadId: 'agenttwo', name: 'AgentTwo' });
	await store.create({ home, project: path.join(project, 'nested-project'), threadId: 'elsewhere', name: 'Altro' });
	const calls = [];
	const router = new AgentRouter({ store, home, projects: [project], request: async (method, params) => {
		calls.push({ method, params }); return method === 'thread/read' ? { thread: { cwd: project, status: { type: 'idle' } } } : { turn: { id: 'turn' } };
	} });
	assert.deepEqual((await router.list()).map(a => a.id), [agentone.id, agenttwo.id]);
	assert.equal((await router.send('agentone', 'AgentTwo', 'Un solo task')).status, 'sent');
	assert.equal(calls.at(-1).params.threadId, 'agenttwo');
	assert.match(calls.at(-1).params.input[0].text, /AgentOne/);
	const other = new AgentRouter({ store, home, projects: [path.join(project, 'nested-project')], request: router.request });
	assert.deepEqual((await other.list()).map(a => a.name), ['Altro']);
	await assert.rejects(other.send('elsewhere', agentone.id, 'No'), /progetto|agente/i);
});
test('legacy agents obtain project from their stored thread and disappear from other folders', async t => {
	const store = await setup(t), home = path.join(store.root, 'home'), project = path.join(store.root, 'project');
	await store.create({ home, threadId: 'old', name: 'Legacy' });
	const request = async () => ({ thread: { id: 'old', cwd: project } });
	const local = new AgentRouter({ store, home, projects: [project], request });
	assert.equal((await local.list()).length, 1);
	assert.equal((await store.load()).agents[0].project, project);
	const other = new AgentRouter({ store, home, projects: [path.join(project, 'child')], request });
	assert.deepEqual(await other.list(), []);
});
test('opening an agent from a chat editor preserves the original document route', async t => {
	const store = await setup(t), home = path.join(store.root, 'home');
	const previous = { root: process.env.ZILPIO_PROFILES_ROOT, home: process.env.CODEX_HOME };
	process.env.ZILPIO_PROFILES_ROOT = store.root; process.env.CODEX_HOME = home;
	const messages = [], editor = {}, sidebar = {};
	const owner = {
		subscriptions: [], broadcastToAllViews() {},
		findPanelByWebview: webview => webview === editor ? {} : undefined,
		async handleMessage(webview, message) { messages.push({ destination: 'editor', message }); },
		postMessageToWebview(webview, message) { if (message.type === 'navigate-to-route') { messages.push({ destination: 'sidebar', message }); } }
	};
	const service = require('../../extensions/zilpio-codex/agents.js').create(owner, { activeTurns: new Set(), pendingTurnStarts: new Map(), request: async () => ({}) }, { workspace: { workspaceFolders: [{ uri: { fsPath: home } }] } });
	t.after(() => {
		service.dispose();
		for (const [key, value] of [['ZILPIO_PROFILES_ROOT', previous.root], ['CODEX_HOME', previous.home]]) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
	});
	const agent = await service.store.create({ home, project: home, threadId: 'target', name: 'Target' });
	await service.handle(editor, { action: 'open', id: agent.id });
	await service.handle(sidebar, { action: 'open', id: agent.id });
	assert.deepEqual(messages, [
		{ destination: 'editor', message: { type: 'navigate-in-new-editor-tab', path: '/local/target' } },
		{ destination: 'sidebar', message: { type: 'navigate-to-route', path: '/local/target' } }
	]);
});
test('prewarmed native chats install tools and explicit routing instructions before dispatch', () => {
	const source = require('node:fs').readFileSync(path.resolve(__dirname, '../patch-official-codex.cjs'), 'utf8');
	assert.match(source, /prewarmThreadStart\(IR,String\(n\),await this\.zilpioProfiles\.agents\.prepareRequest\("thread\/start",o,String\(n\)\)/);
});
