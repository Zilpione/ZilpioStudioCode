/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { chromium } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
	const run = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-agents-editor-')), registry = path.join(run, 'registry'), home = path.join(run, 'environment'), account = path.join(run, 'account'), project = path.join(run, 'project');
	let child, browser, frame, delegated = false, workerContext = false, returned = false, sequence = 0; const toolOutputs = [];
	const model = http.createServer(async (req, res) => {
		if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
		let body = ''; for await (const chunk of req) { body += chunk; }
		const input = JSON.parse(body), json = JSON.stringify(input), namespace = input.tools?.find(t => t.name === 'mcp__zilpio_agents');
		toolOutputs.push(...(input.input || []).filter(i => i.type?.includes('call_output')));
		let item;
		if (json.includes('request-AgentTwo-live') && !delegated && namespace) {
			delegated = true; item = { type: 'function_call', id: 'fc_live', call_id: 'call_live', namespace: namespace.name, name: 'send_message', arguments: JSON.stringify({ recipient: 'AgentTwo', message: 'task-visible-in-AgentTwo-chat' }) };
		} else {
			if (json.includes('task-visible-in-AgentTwo-chat') && !json.includes('request-AgentTwo-live')) { workerContext = json.includes('worker-context-sentinel'); }
			returned ||= json.includes('[Risultato ZilpioAgent @AgentTwo');
			item = { type: 'message', id: 'msg_live_' + ++sequence, role: 'assistant', content: [{ type: 'output_text', text: returned ? 'AgentOne received AgentTwo result' : json.includes('task-visible-in-AgentTwo-chat') && !json.includes('request-AgentTwo-live') ? 'AgentTwo completed live task' : 'AgentOne ready', annotations: [] }] };
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const event of [{ type: 'response.created', response: { id: `r_live_${sequence}` } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `r_live_${sequence}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } res.end();
	});
	await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
	try {
		for (const dir of [registry, account, project, path.join(run, 'user/User')]) { await fs.mkdir(dir, { recursive: true }); }
		const seeded = spawnSync(process.execPath, [path.join(__dirname, 'zilpio-agents-protocol.cjs')], { cwd: root, env: { ...process.env, ZILPIO_AGENT_SEED_DIR: home, ZILPIO_AGENT_SEED_CWD: project, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode' }, windowsHide: true, encoding: 'utf8', timeout: 60000 });
		assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
		await fs.writeFile(path.join(home, 'config.toml'), `[model_providers.local]\nname = "Local mock"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = true\n`);
		// The IDE history filters for its own provider/source. Only this temporary fixture is changed.
		const { DatabaseSync } = require('node:sqlite');
		for (const file of (await fs.readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))) {
			const db = new DatabaseSync(path.join(home, file));
			try { db.prepare("UPDATE threads SET model_provider = 'openai', source = 'vscode'").run(); } finally { db.close(); }
		}
		await fs.writeFile(path.join(account, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-zilpio-runtime-local-test' }));
		for (const [file, value] of [['profiles', { version: 1, activeProfileId: 'local', profiles: [{ id: 'local', name: 'Local test', home: account, provider: 'openai' }] }], ['environments', { version: 1, activeProfileId: 'local', profiles: [{ id: 'local', name: 'Local test', home, provider: 'openai' }] }]]) { await fs.writeFile(path.join(registry, `${file}.json`), JSON.stringify(value)); }
		await fs.writeFile(path.join(run, 'user/User/settings.json'), JSON.stringify({ 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'chatgpt.openOnStartup': true }));
		const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
		const env = { ...process.env, ZILPIO_PROFILES_ROOT: registry, CODEX_HOME: home, OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1` }; delete env.ELECTRON_RUN_AS_NODE; delete env.ZILPIO_LAUNCHER; delete env.OPENAI_API_KEY;
		child = spawn(path.join(root, '.build/clean-host/ZSCode.Editor.exe'), ['--user-data-dir', path.join(run, 'user'), '--extensions-dir', path.join(run, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', `--remote-debugging-port=${port}`, project], { env, windowsHide: true, stdio: 'ignore' });
		for (let i = 0; i < 80; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await pause(300); } }
		assert.ok(browser, 'Editor must expose CDP');
		await browser.contexts()[0].addInitScript(() => {
			Object.defineProperty(window, 'zilpioAgents', { configurable: true, set(value) {
				const connect = value.connect; value.connect = api => { window.zilpioTestApi = api; return connect(api); };
				Object.defineProperty(window, 'zilpioAgents', { configurable: true, writable: true, value });
			} });
		});
		const page = browser.contexts()[0].pages()[0]; const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', message => { if (message.type() === 'error') { errors.push(message.text().slice(0, 700)); } });
		for (let i = 0; i < 100; i++) {
			for (const candidate of page.frames()) { try { if (await candidate.evaluate(() => !!window.zilpioAgents)) { frame = candidate; break; } } catch { /* Frame reload. */ } }
			if (frame) { break; } await pause(300);
		}
		assert.ok(frame, 'Official Codex frame must load the agent UI');
		for (let i = 0; i < 100; i++) {
			for (const candidate of page.frames()) {
				try {
					if (!await candidate.evaluate(() => !!window.zilpioAgents)) { continue; } frame = candidate;
					if (await frame.getByRole('button', { name: 'Continue', exact: true }).count()) { await frame.getByRole('button', { name: 'Continue', exact: true }).click(); }
				} catch { /* Onboarding replaces the webview frame. */ }
			}
			try { if (await frame.locator('[contenteditable=true],textarea').count()) { break; } } catch { /* Reacquire after navigation. */ } await pause(300);
		}
		await pause(1000);
		if (await frame.getByRole('button', { name: /Recent chats/ }).count()) { await frame.getByRole('button', { name: /Recent chats/ }).click(); await pause(1000); }
		const row = frame.locator('[data-zilpio-thread]').filter({ hasText: 'Chat locale Elio' }).last(); await row.waitFor();
		await row.dispatchEvent('contextmenu', { clientX: 30, clientY: 80 }); await frame.getByRole('menuitem', { name: 'Crea ZilpioAgent' }).click();
		await frame.getByRole('dialog', { name: 'Crea ZilpioAgent' }).waitFor();
		await frame.waitForFunction(() => !document.querySelector('.zilpio-agent-dialog button[type=submit]').disabled);
		await frame.getByLabel('Nome', { exact: true }).fill('Elio'); await frame.getByLabel('Colore', { exact: true }).fill('#76b8ed');
		await frame.getByRole('button', { name: 'Salva', exact: true }).click();
		await frame.getByRole('button', { name: 'Apri agente Elio', exact: true }).waitFor();
		await frame.locator('[data-codex-composer=true]').click();
		await frame.locator('[data-codex-composer=true]').fill('Chiedi a @El');
		await frame.getByRole('option', { name: '@Elio', exact: true }).click();
		assert.equal(await frame.locator('[data-codex-composer=true]').innerText(), 'Chiedi a @Elio ');
		await frame.getByRole('button', { name: 'Apri agente Elio', exact: true }).click({ button: 'right' }); await frame.getByRole('menuitem', { name: 'Modifica agente' }).click();
		await frame.getByLabel('Nome', { exact: true }).fill('Orione'); await frame.getByLabel('Colore', { exact: true }).fill('#61c8a5'); await frame.getByRole('button', { name: 'Salva', exact: true }).click();
		await frame.getByRole('button', { name: 'Apri agente Orione', exact: true }).waitFor();
		await page.screenshot({ path: path.join(root, '.build/zilpio-agents-editor.png') });
		await frame.getByRole('button', { name: 'Apri agente Orione', exact: true }).click();
		await frame.getByText('Verifica locale del worker riuscita.', { exact: true }).waitFor({ timeout: 20000 });
		await frame.getByRole('button', { name: 'Apri agente Orione', exact: true }).click({ button: 'right' }); await frame.getByRole('menuitem', { name: 'Elimina agente' }).click();
		assert.ok(await frame.evaluate(() => !!window.zilpioTestApi), 'Capture the real native bridge');
		async function rpc(method, params, prewarm = false) {
			return frame.evaluate(({ method, params, prewarm }) => new Promise((resolve, reject) => {
				const id = crypto.randomUUID(), timer = setTimeout(() => { window.removeEventListener('message', handler); reject(Error('Native request timed out: ' + method)); }, 20000);
				function handler(event) { const data = event.data; if (data?.type === 'mcp-response' && String(data.message?.id) === id) { clearTimeout(timer); window.removeEventListener('message', handler); data.message.error ? reject(Error(data.message.error.message)) : resolve(data.message.result); } }
				window.addEventListener('message', handler); window.zilpioTestApi.postMessage(prewarm ? { type: 'thread-prewarm-start', request: { id, params }, retainResponse: true } : { type: 'mcp-request', hostId: 'local', request: { id, method, params } });
			}), { method, params, prewarm });
		}
		const recipient = await rpc('thread/start', { cwd: project, model: 'gpt-5.4', modelProvider: 'local', sandbox: 'read-only', approvalPolicy: 'on-request' }, true);
		await rpc('turn/start', { threadId: recipient.thread.id, input: [{ type: 'text', text: 'worker-context-sentinel' }] });
		for (let i = 0; i < 70; i++) { const read = await rpc('thread/read', { threadId: recipient.thread.id }); if (read.thread.status.type === 'idle') { break; } await pause(100); }
		await frame.evaluate(threadId => window.zilpioTestApi.postMessage({ type: 'zilpio-agents', action: 'create', threadId, name: 'AgentTwo', color: '#61c8a5', requestId: 'create-agenttwo' }), recipient.thread.id);
		await frame.getByRole('button', { name: 'Apri agente AgentTwo', exact: true }).waitFor();
		const manager = await rpc('thread/start', { cwd: project, model: 'gpt-5.4', modelProvider: 'local', sandbox: 'read-only', approvalPolicy: 'on-request' }, true);
		const inventory = await rpc('mcpServerStatus/list', { threadId: manager.thread.id }); assert.ok(inventory.data.find(s => s.name === 'zilpio_agents')?.tools.send_message, 'Prewarmed chats must have Zilpio tools');
		await rpc('turn/start', { threadId: manager.thread.id, input: [{ type: 'text', text: 'persist-manager' }] });
		for (let i = 0; i < 70; i++) { const read = await rpc('thread/read', { threadId: manager.thread.id }); if (read.thread.status.type === 'idle') { break; } await pause(100); }
		await frame.evaluate(threadId => window.zilpioTestApi.postMessage({ type: 'zilpio-agents', action: 'create', threadId, name: 'AgentOne', color: '#ec9a70', requestId: 'create-agentone' }), manager.thread.id);
		await frame.getByRole('button', { name: 'Apri agente AgentOne', exact: true }).waitFor();
		await frame.getByRole('button', { name: 'Apri agente AgentOne', exact: true }).click();
		await frame.getByText('AgentOne ready', { exact: true }).waitFor();
		await rpc('turn/start', { threadId: manager.thread.id, input: [{ type: 'text', text: 'request-AgentTwo-live' }] });
		for (let i = 0; i < 100 && !toolOutputs.length; i++) {
			const allow = frame.getByRole('button', { name: 'Allow once', exact: true });
			if (await allow.count() && await allow.first().isVisible()) { await allow.first().click(); }
			await pause(100);
		}
		await frame.getByRole('button', { name: 'Apri agente AgentTwo', exact: true }).click();
		await frame.getByText('task-visible-in-AgentTwo-chat', { exact: false }).waitFor({ timeout: 20000 });
		await frame.getByText('AgentTwo completed live task', { exact: true }).waitFor({ timeout: 20000 });
		assert.equal(delegated, true); assert.equal(workerContext, true);
		for (let i = 0; i < 80 && !returned; i++) { await pause(100); } assert.equal(returned, true);
		await page.screenshot({ path: path.join(root, '.build/zilpio-agents-message-delivery.png') });
		await frame.getByRole('button', { name: 'Apri agente AgentOne', exact: true }).click({ button: 'right' }); await frame.getByRole('menuitem', { name: 'Elimina agente' }).click();
		await frame.getByRole('button', { name: 'Apri agente AgentTwo', exact: true }).click({ button: 'right' }); await frame.getByRole('menuitem', { name: 'Modifica agente' }).click();
		await frame.getByLabel('Nome', { exact: true }).fill('AgentTwoFinale'); await frame.getByRole('button', { name: 'Salva', exact: true }).click();
		await frame.getByRole('button', { name: 'Apri agente AgentTwoFinale', exact: true }).click({ button: 'right' }); await frame.getByRole('menuitem', { name: 'Elimina agente' }).click();
		await frame.waitForFunction(() => !document.querySelector('.zilpio-agent-entry'));
		assert.equal(JSON.parse(await fs.readFile(path.join(registry, 'agents.json'), 'utf8')).agents.length, 0);
		console.log('PASS: real editor CRUD/completion; native prewarm installs tools; AgentOne sends to existing AgentTwo chat; request and result visible, prior context preserved and result returned to AgentOne.');
	} catch (error) {
		console.error('Delivery state:', JSON.stringify({ delegated, workerContext, returned, toolOutputs }));
		await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(root, '.build/zilpio-agents-delivery-failure.png') }).catch(() => {});
		await fs.cp(path.join(run, 'user/logs'), path.join(root, '.build/zilpio-agents-editor-logs'), { recursive: true }).catch(() => {}); throw error;
	} finally {
		await browser?.close(); if (child) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
		await new Promise(resolve => model.close(resolve));
		await fs.rm(run, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
