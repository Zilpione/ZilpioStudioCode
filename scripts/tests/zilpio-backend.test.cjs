const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
let CodexRpc, CodexBackend;
try { ({ CodexRpc } = require('../../extensions/zilpio-codex/rpc.js')); ({ CodexBackend } = require('../../extensions/zilpio-codex/backend.js')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') { throw error; } }

test('RPC handles split frames and rejects outstanding requests when the process exits', async () => {
	assert.equal(typeof CodexRpc, 'function', 'CodexRpc transport is required');
	const child = new EventEmitter();
	child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
	const rpc = new CodexRpc(child);
	const request = rpc.request('test', {});
	child.stdout.write('{"id":1,"result":'); child.stdout.write('{"ok":true}}\n');
	assert.deepEqual(await request, { ok: true });
	const pending = rpc.request('second', {});
	child.emit('exit', 1);
	await assert.rejects(pending, /closed/);
	rpc.dispose();
});

test('switch preserves the live thread and refuses a switch during a turn', async () => {
	assert.equal(typeof CodexBackend, 'function', 'CodexBackend is required');
	const calls = [];
	const backend = new CodexBackend('/unused', () => '/binary', () => {}, async (_, p) => ({ type: 'chatgptAuthTokens', accessToken: `token-${p.id}`, chatgptAccountId: p.id }));
	backend.rpc = { request: async (method, params) => { calls.push({ method, params }); return {}; } };
	backend.threadId = 'same-thread';
	await backend.switchProfile({ id: 'work', name: 'Work' });
	assert.equal(backend.threadId, 'same-thread');
	assert.equal(backend.profile.id, 'work');
	assert.equal(calls[0].method, 'account/login/start');
	assert.equal(calls[0].params.chatgptAccountId, 'work');
	backend.busy = true;
	await assert.rejects(backend.switchProfile({ id: 'zilpio' }), /turn/);
	assert.equal(calls.length, 1);
});

test('failed authentication retains the previous profile', async () => {
	assert.equal(typeof CodexBackend, 'function', 'CodexBackend is required');
	const backend = new CodexBackend('/unused', () => '/binary', () => {}, async () => { throw new Error('Login required'); });
	backend.rpc = { request: async () => ({}) };
	backend.profile = { id: 'previous' };
	await assert.rejects(backend.switchProfile({ id: 'next' }), /Login required/);
	assert.equal(backend.profile.id, 'previous');
});

test('changing the home of an existing JSON profile requires reauthentication', async () => {
	assert.equal(typeof CodexBackend, 'function');
	let authenticatedHome;
	const backend = new CodexBackend('/unused', () => '/binary', () => {}, async (_, profile) => { authenticatedHome = profile.home; return { type: 'apiKey', apiKey: 'fake' }; });
	backend.rpc = { request: async method => method === 'turn/start' ? { turn: { id: 'turn' } } : {} };
	backend.authenticated = true;
	backend.profile = { id: 'same', home: '/old', provider: 'openai' };
	backend.threadId = 'thread';
	backend.meta = { chats: [{ id: 'thread', turnProfiles: [] }] };
	backend.saveMeta = async () => {};
	await backend.send('hello', '/workspace', { id: 'same', name: 'New', home: '/new', provider: 'openai' });
	assert.equal(authenticatedHome, '/new');
});

test('a corrupted RPC frame terminates the process instead of leaking a live backend', async () => {
	assert.equal(typeof CodexRpc, 'function');
	const child = new EventEmitter();
	child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
	let killed = false;
	child.kill = () => { killed = true; };
	const rpc = new CodexRpc(child);
	const pending = rpc.request('test', {});
	child.stdout.write('not json\n');
	await assert.rejects(pending, /Invalid Codex/);
	assert.equal(killed, true);
});

test('new chat after reconnect does not try to resume the previous thread', async () => {
	assert.equal(typeof CodexBackend, 'function');
	const calls = [];
	const backend = new CodexBackend('/unused', () => '/binary', () => {});
	backend.rpc = { request: async method => { calls.push(method); return method === 'thread/start' ? { thread: { id: 'new' } } : { turn: { id: 'turn' } }; } };
	backend.profile = { id: 'same', home: '/home', provider: 'openai' };
	backend.authenticated = true;
	backend.threadId = 'old';
	backend.needsResume = true;
	backend.meta = { chats: [] };
	backend.saveMeta = async () => {};
	backend.newChat();
	await backend.send('hello', '/workspace', backend.profile);
	assert.equal(calls.includes('thread/resume'), false);
	assert.equal(backend.threadId, 'new');
});
