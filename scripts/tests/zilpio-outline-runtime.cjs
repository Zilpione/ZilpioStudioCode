/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
	const run = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-outline-'));
	const registry = path.join(run, 'registry'), home = path.join(run, 'home'), project = path.join(run, 'project'), account = path.join(run, 'account');
	let child, browser, frame;
	const server = http.createServer((_, response) => { response.writeHead(404); response.end(); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		for (const dir of [registry, home, project, account, path.join(run, 'user/User')]) { await fs.mkdir(dir, { recursive: true }); }
		await fs.writeFile(path.join(account, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-local-outline-test' }));
		await fs.writeFile(path.join(home, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "local"\n[model_providers.local]\nname = "Local test"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`);
		for (const [file, value] of [
			['profiles', { version: 1, activeProfileId: 'local', profiles: [{ id: 'local', name: 'Test', home: account, provider: 'openai' }] }],
			['environments', { version: 1, activeProfileId: 'local', profiles: [{ id: 'local', name: 'Test', home, provider: 'openai' }] }],
			['workspaces', { version: 1, workspaces: [{ id: 'project', name: 'Outline test', folder: project, color: '#7c8aff', accountId: 'local', environmentId: 'local' }], usageCards: [], selections: {} }]
		]) { await fs.writeFile(path.join(registry, file + '.json'), JSON.stringify(value)); }
		await new (require('../../extensions/zilpio-codex/startup-state.js').StartupState)(registry).record({ project, accountId: 'local', environmentId: 'local', params: { model: 'gpt-6-luna', effort: 'high', serviceTier: 'default' } });
		await fs.writeFile(path.join(run, 'user/User/settings.json'), JSON.stringify({ 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'chatgpt.openOnStartup': true }));
		const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
		const env = { ...process.env, ZILPIO_PROFILES_ROOT: registry, CODEX_HOME: home, OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` }; delete env.ELECTRON_RUN_AS_NODE; delete env.ZILPIO_LAUNCHER; delete env.OPENAI_API_KEY;
		child = spawn(path.join(root, '.build/clean-host/ZSCode.Editor.exe'), ['--user-data-dir', path.join(run, 'user'), '--extensions-dir', path.join(run, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', `--remote-debugging-port=${port}`, project], { env, windowsHide: true, stdio: 'ignore' });
		for (let i = 0; i < 80; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await pause(300); } }
		assert.ok(browser, 'Editor must start');
		const page = browser.contexts()[0].pages()[0];
		for (let i = 0; i < 120; i++) {
			for (const candidate of page.frames()) {
				try {
					if (!await candidate.evaluate(() => !!window.zilpioAgents)) { continue; }
					frame = candidate;
					const next = frame.getByRole('button', { name: 'Continue', exact: true });
					if (await next.count()) { await next.click(); }
					if (await frame.locator('[data-composer-surface-variant]').count()) { break; }
				} catch { /* Onboarding replaces the frame. */ }
			}
			try { if (frame && await frame.locator('[data-composer-surface-variant]').count()) { break; } } catch { /* Reload. */ }
			await pause(300);
		}
		assert.ok(frame, 'Official chat must load'); await pause(3000);
		const keepModel = frame.getByRole('button', { name: 'Continue with current model', exact: true });
		if (await keepModel.count()) { await keepModel.click(); }
		await frame.waitForFunction(() => document.querySelector('.zilpio-account-selector')?.checkVisibility() && document.querySelector('.zilpio-environment-selector')?.checkVisibility() && document.querySelectorAll('.zilpio-usage [role="progressbar"]').length === 2 && /gpt-6-luna.*high/.test(document.querySelector('.zilpio-current-model')?.textContent || ''));
		const state = await frame.evaluate(() => {
			const form = document.querySelector('[data-composer-input]');
			if (!form) { return { missingForm: true }; }
			const style = getComputedStyle(form), rect = form.getBoundingClientRect();
			const ancestors = []; for (let node = form; node; node = node.parentElement) { const s = getComputedStyle(node), r = node.getBoundingClientRect(); ancestors.push({ tag: node.tagName, className: node.className, overflow: s.overflow, top: r.top, height: r.height }); }
			const surface = document.querySelector('[data-composer-surface-variant]');
			const toolbar = surface.querySelector('[data-composer-footer-responsive]');
			return { color: getComputedStyle(document.documentElement).getPropertyValue('--zilpio-workspace-color'), outline: style.outline, offset: style.outlineOffset, top: rect.top, height: rect.height, surfaceOutline: getComputedStyle(surface).outlineStyle, containsToolbar: form.contains(toolbar), ancestors };
		});
		await fs.writeFile(path.join(root, '.build/outline-runtime.json'), JSON.stringify(state, null, 2));
		await page.screenshot({ path: path.join(root, '.build/outline-runtime.png') });
		await fs.writeFile(path.join(root, '.build/outline-runtime.html'), await frame.content());
		console.log(JSON.stringify({ color: state.color, outline: state.outline, offset: state.offset, top: state.top, height: state.height }));
		assert.equal(state.color?.trim(), '#7c8aff');
		assert.equal(state.outline, 'rgb(124, 138, 255) solid 2px');
		assert.equal(state.offset, '-2px');
		assert.equal(state.surfaceOutline, 'none');
		assert.equal(state.containsToolbar, false);
		assert.ok(state.height > 0);
		assert.ok(state.top > 0, 'The outline starts at the composer, below the conversation');
	} finally {
		await browser?.close();
		if (child) { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
		await new Promise(resolve => server.close(resolve));
		assert.ok(path.resolve(run).startsWith(path.resolve(os.tmpdir()) + path.sep));
		await fs.rm(run, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
