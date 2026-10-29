/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
// Real Codex binary, local mock model, temporary home, no real accounts or inference.
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { startRpc } = require('../../extensions/zilpio-codex/rpc.js');
const { create } = require('../../extensions/zilpio-codex/agents.js');
(async () => {
	const root = process.env.ZILPIO_AGENT_SEED_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-agents-protocol-')); await fs.mkdir(root, { recursive: true });
	const binary = process.argv[2] || path.resolve('.build/clean-host/2a59476c9b/resources/app/extensions/openai.chatgpt/bin/windows-x86_64/codex.exe');
	const previous = { home: process.env.CODEX_HOME, root: process.env.ZILPIO_PROFILES_ROOT };
	let rpc, bridge, worker, delegated = false, sequence = 0, withTools = false;
	const calls = [], failures = [], notifications = [];
	const model = http.createServer(async (req, res) => {
		if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
		let body = ''; for await (const chunk of req) { body += chunk; }
		const input = JSON.parse(body), json = JSON.stringify(input), tools = input.tools || [];
		const namespace = tools.find(t => t.name === 'mcp__zilpio_agents');
		calls.push(input); withTools ||= !!namespace || json.includes('mcp__zilpio_agents__send_message');
		const send = tools.find(t => t.name?.endsWith('send_message')) || namespace?.tools?.find(t => t.name === 'send_message');
		const codeMode = json.includes('mcp__zilpio_agents__send_message') && !send;
		let item;
		if (json.includes('delegate-once') && (send || codeMode) && !delegated) {
			delegated = true;
			item = codeMode ? { type: 'custom_tool_call', id: 'fc_local', call_id: 'call_local', name: 'exec', namespace: 'functions', input: `const result = await tools.mcp__zilpio_agents__send_message(${JSON.stringify({ recipient: worker.id, message: 'worker-task: verifica locale' })}); text(result);` } : { type: 'function_call', id: 'fc_local', call_id: 'call_local', name: send.name, ...(namespace ? { namespace: namespace.name } : {}), arguments: JSON.stringify({ recipient: worker.id, message: 'worker-task: verifica locale' }) };
		} else {
			const text = json.includes('[Risultato ZilpioAgent') ? 'Risultato ricevuto dall’orchestratore.' : json.includes('worker-task: verifica locale') && !json.includes('delegate-once') ? 'Verifica locale del worker riuscita.' : 'Turno locale concluso.';
			item = { id: `msg_${++sequence}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const event of [{ type: 'response.created', response: { id: `r_${sequence}` } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `r_${sequence}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } res.end();
	});
	await new Promise(r => model.listen(0, '127.0.0.1', r));
	async function start() { rpc = startRpc(binary, root, true); rpc.handleRequest = async (method, params) => { if (method === 'mcpServer/elicitation/request') { const content = Object.fromEntries(Object.entries(params.requestedSchema?.properties || {}).map(([key, spec]) => [key, spec.enum?.[0] ?? spec.default ?? (spec.type === 'boolean' ? true : 'accept')])); return { action: 'accept', content }; } throw new Error('Unexpected request: ' + method); }; await rpc.initialize(); await rpc.request('account/login/start', { type: 'apiKey', apiKey: 'sk-local-agent-test' }); }
	async function stop() { if (!rpc) { return; } const child = rpc.child; const stopped = new Promise(r => child.once('close', r)); if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } rpc.dispose(); if (!child.stdout.destroyed) { await stopped; } rpc = null; }
	function until(predicate) {
		return new Promise((resolve, reject) => {
			if (predicate()) { resolve(); return; }
			const timer = setTimeout(() => { rpc.off('notification', check); reject(new Error('Protocol test timed out: ' + JSON.stringify({ failures, delegated, withTools, notifications, outputs: calls.flatMap(c => (c.input || []).filter(i => i.type?.includes('call_output'))) }))); }, 20000);
			function check() { if (predicate()) { clearTimeout(timer); rpc.off('notification', check); resolve(); } }
			rpc.on('notification', check);
		});
	}
	try {
		process.env.CODEX_HOME = root; process.env.ZILPIO_PROFILES_ROOT = path.join(root, 'registry');
		const config = { 'model_providers.local.name': 'Local mock', 'model_providers.local.base_url': `http://127.0.0.1:${model.address().port}/v1`, 'model_providers.local.wire_api': 'responses', 'model_providers.local.supports_websockets': false, 'model_providers.local.requires_openai_auth': true };
		await start();
		const old = await rpc.request('thread/start', { cwd: process.env.ZILPIO_AGENT_SEED_CWD || root, model: 'gpt-5.4', modelProvider: 'local', config, sandbox: 'read-only', approvalPolicy: 'on-request' });
		await rpc.request('thread/name/set', { threadId: old.thread.id, name: 'Chat locale orchestratore' });
		let initialComplete = false;
		rpc.on('notification', m => { if (m === 'turn/completed') { initialComplete = true; } });
		await rpc.request('turn/start', { threadId: old.thread.id, input: [{ type: 'text', text: 'persist existing conversation' }] }); await until(() => initialComplete); await stop();
		await start();
		const activeTurns = new Set();
		const project = process.env.ZILPIO_AGENT_SEED_CWD || root, vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: project } }] } };
		const accounts = { current: { id: 'local' }, activeTurns, pendingTurnStarts: new Map(), bootstrap: async () => {}, request: (method, params) => rpc.request(method, params) };
		const owner = { subscriptions: [], postMessageToWebview() {}, broadcastToAllViews(data) { if (data.error) { failures.push(data.error); } } };
		bridge = create(owner, accounts, vscode);
		const onNotification = (method, params) => {
			if (method === 'turn/started') { activeTurns.add(params.threadId); }
			if (method === 'turn/completed') { activeTurns.delete(params.threadId); notifications.push({ threadId: params.threadId, status: params.turn.status }); }
			bridge.notification(method, params);
		};
		rpc.on('notification', onNotification);
		console.log('Checking MCP on resumed conversation…');
		const resumed = await rpc.request('thread/resume', await bridge.prepareRequest('thread/resume', { threadId: old.thread.id, config, model: 'gpt-5.4', modelProvider: 'local', excludeTurns: true }));
		assert.equal(resumed.thread.id, old.thread.id);
		const workerThread = await rpc.request('thread/start', await bridge.prepareRequest('thread/start', { cwd: project, model: 'gpt-5.4', modelProvider: 'local', config, sandbox: 'read-only', approvalPolicy: 'on-request' }, 'worker-start'));
		bridge.receive({ id: 'worker-start', result: workerThread });
		await rpc.request('thread/name/set', { threadId: workerThread.thread.id, name: 'Chat locale Elio' });
		worker = await bridge.store.create({ home: root, project, threadId: workerThread.thread.id, name: 'Elio', color: '#123abc' });
		await rpc.request('turn/start', { threadId: workerThread.thread.id, input: [{ type: 'text', text: 'persist worker before unloading' }] });
		await until(() => notifications.some(n => n.threadId === worker.threadId));
		// The local provider must also exist for automatic resume, as a real configured provider would.
		await fs.writeFile(path.join(root, 'config.toml'), `[model_providers.local]\nname = "Local mock"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = true\n`);
		bridge.dispose(); await stop(); await start(); bridge = create(owner, accounts, vscode); rpc.on('notification', onNotification);
		await rpc.request('thread/resume', await bridge.prepareRequest('thread/resume', { threadId: old.thread.id, config, model: 'gpt-5.4', modelProvider: 'local', excludeTurns: true }));
		const unloaded = await rpc.request('thread/read', { threadId: worker.threadId, includeTurns: false }); assert.equal(unloaded.thread.status.type, 'notLoaded');
		console.log('Checking real tool delegation and reply…');
		const mcp = await rpc.request('mcpServerStatus/list', { threadId: old.thread.id }); assert.ok(mcp.data.find(s => s.name === 'zilpio_agents')?.tools.send_message);
		await rpc.request('turn/start', { threadId: old.thread.id, input: [{ type: 'text', text: 'delegate-once to @Elio using the available send_message tool' }] });
		await until(() => notifications.filter(n => n.threadId === old.thread.id).length >= 2);
		assert.equal(withTools, true); assert.equal(delegated, true); assert.deepEqual(failures, []);
		assert.ok(calls.some(c => JSON.stringify(c.input).includes('Verifica locale del worker riuscita.')));
		assert.equal(notifications.filter(n => n.threadId === worker.threadId).length, 2);
		assert.ok(notifications.every(n => n.status === 'completed'));
		console.log('PASS: existing conversation resumed with MCP tools; real Codex tool call delegates to worker, returns result once to orchestrator; temporary mock credentials/model only.');
	} finally {
		if (failures.length) { console.error(failures); }
		bridge?.dispose(); await stop(); await new Promise(r => model.close(r));
		if (previous.home === undefined) { delete process.env.CODEX_HOME; } else { process.env.CODEX_HOME = previous.home; }
		if (previous.root === undefined) { delete process.env.ZILPIO_PROFILES_ROOT; } else { process.env.ZILPIO_PROFILES_ROOT = previous.root; }
		if (!process.env.ZILPIO_AGENT_SEED_DIR) { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
