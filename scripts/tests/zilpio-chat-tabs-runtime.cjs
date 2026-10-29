/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { chromium } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net'), http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
	const run = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-chat-tabs-')), registry = path.join(run, 'registry'), home = path.join(run, 'environment'), account = path.join(run, 'account'), project = path.join(run, 'project');
	let child, browser, frame, sequence = 0;
	const model = http.createServer(async (req, res) => {
		if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
		let body = ''; for await (const chunk of req) { body += chunk; }
		const item = { type: 'message', id: 'msg_tabs_' + ++sequence, role: 'assistant', content: [{ type: 'output_text', text: body.includes('tab-live-update-sentinel') ? 'Local live tab response' : 'Local tab response ' + sequence, annotations: [] }] };
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const event of [{ type: 'response.created', response: { id: `r_live_${sequence}` } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `r_live_${sequence}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } res.end();
	});
	await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
	try {
		for (const dir of [registry, home, account, project, path.join(run, 'user/User')]) { await fs.mkdir(dir, { recursive: true }); }
		await fs.writeFile(path.join(home, 'config.toml'), `model_provider = "local"\n[model_providers.local]\nname = "Local mock"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = true\n`);
		const { startRpc } = require('../../extensions/zilpio-codex/rpc.js');
		const seed = startRpc(path.join(root, '.build/clean-host/2a59476c9b/resources/app/extensions/openai.chatgpt/bin/windows-x86_64/codex.exe'), home, true);
		try {
			await seed.initialize(); await seed.request('account/login/start', { type: 'apiKey', apiKey: 'sk-zilpio-tabs-local-test' });
			for (const [name, text] of [['Chat locale orchestratore', 'persist existing conversation'], ['Chat locale Elio', 'persist worker before unloading']]) {
				const { thread } = await seed.request('thread/start', { cwd: project, model: 'gpt-5.4', modelProvider: 'local', sandbox: 'read-only', approvalPolicy: 'never' });
				const completed = new Promise((resolve, reject) => {
					const timer = setTimeout(() => { seed.off('notification', check); reject(Error('Seed turn timed out')); }, 20000);
					function check(method, params) { if (method === 'turn/completed' && params.threadId === thread.id) { clearTimeout(timer); seed.off('notification', check); resolve(); } }
					seed.on('notification', check);
				});
				await seed.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] }); await completed;
				await seed.request('thread/name/set', { threadId: thread.id, name });
				await new (require('../../extensions/zilpio-codex/agents.js').AgentStore)(registry).create({ home, project, threadId: thread.id, name: name.endsWith('Elio') ? 'Worker' : 'Manager' });

			}
		} finally {
			const closed = new Promise(resolve => seed.child.once('close', resolve));
			seed.dispose(); await closed;
		}
		const { DatabaseSync } = require('node:sqlite');
		for (const file of (await fs.readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))) {
			const db = new DatabaseSync(path.join(home, file));
			try { db.prepare("UPDATE threads SET source = 'vscode'").run(); } finally { db.close(); }
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
					if (await frame.getByText(/Codex can make mistakes/).count() && await frame.getByRole('button', { name: 'Continue', exact: true }).count()) { await frame.getByRole('button', { name: 'Continue', exact: true }).click(); }
				} catch { /* Onboarding replaces the webview frame. */ }
			}
			try { if (await frame.getByRole('button', { name: /^Apri agente Worker:/ }).count() && !await frame.getByText(/Codex can make mistakes/).count()) { break; } } catch { /* Reacquire after navigation. */ } await pause(300);
		}
		await pause(1000);

		async function rpc(method, params, prewarm = false) {
			return frame.evaluate(({ method, params, prewarm }) => new Promise((resolve, reject) => {
				const id = crypto.randomUUID(), timer = setTimeout(() => { window.removeEventListener('message', handler); reject(Error('Native request timed out: ' + method)); }, 20000);
				function handler(event) { const data = event.data; if (data?.type === 'mcp-response' && String(data.message?.id) === id) { clearTimeout(timer); window.removeEventListener('message', handler); data.message.error ? reject(Error(data.message.error.message)) : resolve(data.message.result); } }
				window.addEventListener('message', handler); window.zilpioTestApi.postMessage(prewarm ? { type: 'thread-prewarm-start', request: { id, params }, retainResponse: true } : { type: 'mcp-request', hostId: 'local', request: { id, method, params } });
			}), { method, params, prewarm });
		}
		// Open an existing chat through its menu, then deliver another chat's drag data into a split editor.
		const workerRow = frame.getByRole('button', { name: /^Apri agente Worker:/ });
		await workerRow.dispatchEvent('contextmenu', { clientX: 30, clientY: 80 });
		await frame.getByRole('menuitem', { name: 'Apri in scheda', exact: true }).click();
		await page.getByRole('tab', { name: /Chat locale Elio/ }).waitFor();
		assert.equal((await page.getByRole('tab', { name: /Chat locale Elio/ }).getAttribute('class')).split(' ').includes('preview'), false, 'Chat tab must be pinned');
		const managerRow = frame.getByRole('button', { name: /^Apri agente Manager:/ });
		const source = await managerRow.boundingBox(), target = await page.locator('.editor-group-container').last().boundingBox();
		assert.ok(source && target, 'Chat row and editor must be visible for native dragging');
		const items = await managerRow.evaluate(row => {
			const dataTransfer = new DataTransfer();
			row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
			return [...dataTransfer.types].map(mimeType => ({ mimeType, data: dataTransfer.getData(mimeType) }));
		});
		assert.ok(items?.some(item => item.mimeType.toLowerCase() === 'codeeditors'), 'Use the editor resource produced by the actual chat drag');
		// Exercise the real workbench drop handlers with the chat's own transfer data.
		// Electron's CDP mouse interception cannot reliably cross webview processes.
		await page.locator('.editor-group-container').last().evaluate((group, items) => {
			const dataTransfer = new DataTransfer();
			for (const item of items) { dataTransfer.setData(item.mimeType, item.data); }
			const rect = group.getBoundingClientRect();
			const options = { bubbles: true, cancelable: true, clientX: rect.right - 25, clientY: rect.top + rect.height / 2, dataTransfer };
			group.dispatchEvent(new DragEvent('dragenter', options));
			const overlay = document.getElementById('monaco-workbench-editor-drop-overlay');
			if (!overlay) { throw Error('Native editor drop overlay must appear'); }
			overlay.dispatchEvent(new DragEvent('dragover', options));
			overlay.dispatchEvent(new DragEvent('drop', options));
			group.dispatchEvent(new DragEvent('dragend', options));
		}, items);
		await page.getByRole('tab', { name: /Chat locale orchestratore/ }).waitFor();
		assert.equal(await page.locator('.editor-group-container').count(), 2, 'Dropping at the edge must split the editor');
		let workerPanel, managerPanel;
		for (let i = 0; i < 80 && (!workerPanel || !managerPanel); i++) {
			for (const candidate of page.frames()) {
				if (candidate === frame) { continue; }
				try {
					if (await candidate.getByText('persist worker before unloading', { exact: true }).count()) { workerPanel = candidate; }
					if (await candidate.getByText('persist existing conversation', { exact: true }).count()) { managerPanel = candidate; }
				} catch { /* A panel may still be initializing. */ }
			} await pause(100);
		}
		assert.ok(workerPanel && managerPanel && workerPanel !== managerPanel, 'Each split must restore its own conversation');
		const workerId = await workerRow.getAttribute('data-zilpio-thread');
		await rpc('turn/start', { threadId: workerId, input: [{ type: 'text', text: 'tab-live-update-sentinel' }] });
		await workerPanel.getByText('tab-live-update-sentinel', { exact: true }).waitFor();
		await workerPanel.getByText('Local live tab response', { exact: true }).waitFor();
		assert.equal(await managerPanel.getByText('tab-live-update-sentinel', { exact: true }).count(), 0, 'Live updates must stay in their conversation');
		await workerPanel.getByRole('button', { name: /^Apri agente Manager:/ }).click();
		assert.equal(await workerPanel.getByText('tab-live-update-sentinel', { exact: true }).count(), 1, 'Opening an agent from a tab must preserve that tab');
		assert.equal(await page.getByRole('tab', { name: /Chat locale orchestratore/ }).count(), 1, 'Opening an existing chat must reveal its tab');
		await page.screenshot({ path: path.join(root, '.build/zilpio-chat-tabs.png') });
		console.log('PASS: chat menu opens a pinned native editor; native drag data creates a split; histories and live updates stay independent.');
		assert.deepEqual(errors.filter(e => e.includes("ReferenceError") || e.includes("TypeError")), []);
	} catch (error) {
		if (frame) { await frame.content().then(html => fs.writeFile(path.join(root, '.build/zilpio-chat-tabs-dom.html'), html)).catch(() => {}); }
		await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(root, '.build/zilpio-chat-tabs-failure.png') }).catch(() => {});
		await fs.cp(path.join(run, 'user/logs'), path.join(root, '.build/zilpio-chat-tabs-logs'), { recursive: true }).catch(() => {}); throw error;
	} finally {
		await browser?.close(); if (child) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
		await new Promise(resolve => model.close(resolve));
		await fs.rm(run, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
