// Local protocol smoke: no account access, inference, or workspace changes.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startRpc } = require('../../extensions/zilpio-codex/rpc.js');

async function main() {
	const binary = process.argv[2];
	if (!binary) { throw new Error('Pass the absolute Codex binary path.'); }
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-appserver-'));
	let rpc;
	const headers = [];
	const server = http.createServer((req, res) => {
		if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
		headers.push(req.headers.authorization);
		req.resume();
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const item = { id: `msg_${headers.length}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'local smoke reply', annotations: [] }] };
		for (const event of [
			{ type: 'response.created', response: { id: `resp_${headers.length}` } },
			{ type: 'response.output_item.done', output_index: 0, item },
			{ type: 'response.completed', response: { id: `resp_${headers.length}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
		]) { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
		res.end();
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		rpc = startRpc(binary, root, true);
		const initialized = await rpc.initialize();
		assert.equal(initialized.codexHome.toLowerCase(), root.toLowerCase());
		await rpc.request('account/login/start', { type: 'apiKey', apiKey: 'sk-zilpio-local-test-a' });
		const config = {
			'model_providers.zilpio-local.name': 'Zilpio local protocol test',
			'model_providers.zilpio-local.base_url': `http://127.0.0.1:${server.address().port}/v1`,
			'model_providers.zilpio-local.wire_api': 'responses',
			'model_providers.zilpio-local.supports_websockets': false,
			'model_providers.zilpio-local.requires_openai_auth': true,
		};
		const created = await rpc.request('thread/start', { cwd: root, model: 'gpt-5.4', modelProvider: 'zilpio-local', config, approvalPolicy: 'on-request', sandbox: 'read-only', persistExtendedHistory: true });
		assert.ok(created.thread.id);
		const turn = async text => {
			let timer;
			let handler;
			const finished = new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Local mock turn timed out')), 15000);
				handler = (method, params) => { if (method === 'turn/completed') { if (params.turn.error) { reject(new Error(params.turn.error.message)); } else { resolve(); } } };
				rpc.on('notification', handler);
			});
			finished.catch(() => {});
			try { await rpc.request('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text }] }); await finished; }
			finally { clearTimeout(timer); rpc.off('notification', handler); }
		};
		await turn('local test turn one');
		await rpc.request('account/login/start', { type: 'apiKey', apiKey: 'sk-zilpio-local-test-b' });
		await turn('local test turn two');
		const resumed = await rpc.request('thread/resume', { threadId: created.thread.id });
		assert.equal(resumed.thread.id, created.thread.id);
		const read = await rpc.request('thread/read', { threadId: created.thread.id, includeTurns: true });
		assert.equal(read.thread.id, created.thread.id);
		assert.equal(read.thread.turns.length, 2);
		assert.deepEqual(headers, ['Bearer sk-zilpio-local-test-a', 'Bearer sk-zilpio-local-test-b']);
		assert.equal(await fs.stat(path.join(root, 'auth.json')).then(() => true, () => false), false);
		const stopped = new Promise(resolve => rpc.child.once('close', resolve));
		rpc.dispose();
		await stopped;
		rpc = startRpc(binary, root, true);
		await rpc.initialize();
		const restored = await rpc.request('thread/resume', { threadId: created.thread.id, modelProvider: 'zilpio-local', config });
		assert.equal(restored.thread.id, created.thread.id);
		assert.equal(restored.thread.turns.length, 2);
		console.log('PASS: two local mock turns, two API identities, one thread, history restored after process restart; no credentials persisted or real inference.');
	} finally {
		if (rpc) {
			const closed = new Promise(resolve => rpc.child.once('close', resolve));
			rpc.dispose();
			await closed;
		}
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
