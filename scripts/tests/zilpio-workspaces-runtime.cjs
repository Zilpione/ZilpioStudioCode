const { chromium } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
	const run = path.join(root, '.build/workspaces-runtime-test');
	const registry = path.join(run, 'registry');
	await fs.mkdir(path.join(run, 'user/User'), { recursive: true });
	await fs.mkdir(registry, { recursive: true });
	const profiles = [], environments = [], workspaces = [], selections = {};
	for (const id of ['a', 'b']) {
		const home = path.join(run, `account-${id}`), environment = path.join(run, `environment-${id}`), folder = path.join(run, `project-${id}`);
		for (const dir of [home, environment, folder]) { await fs.mkdir(dir, { recursive: true }); }
		// Dummy API identities only. No prompt or inference is sent by this test.
		await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: `sk-zilpio-local-workspace-test-${id}` }));
		profiles.push({ id, name: `Account ${id.toUpperCase()}`, home, provider: 'openai' });
		environments.push({ id, name: `Environment ${id.toUpperCase()}`, home: environment, provider: 'openai' });
		workspaces.push({ id, name: `Progetto ${id.toUpperCase()}`, folder, accountId: id, environmentId: id, color: id === 'a' ? '#7c8aff' : '#54c5ac' });
		selections[process.platform === 'win32' ? folder.toLowerCase() : folder] = { id, accountId: id, environmentId: id };
	}
	for (const [file, value] of [['profiles', { version: 1, activeProfileId: 'a', profiles }], ['environments', { version: 1, activeProfileId: 'a', profiles: environments }], ['workspaces', { version: 1, workspaces, usageCards: [], selections }]]) { await fs.writeFile(path.join(registry, `${file}.json`), JSON.stringify(value)); }
	await fs.writeFile(path.join(run, 'user/User/settings.json'), JSON.stringify({ 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'chatgpt.openOnStartup': true }));
	const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
	const env = { ...process.env, ZILPIO_PROFILES_ROOT: registry, CODEX_HOME: environments[0].home };
	delete env.ELECTRON_RUN_AS_NODE; delete env.ZILPIO_LAUNCHER; delete env.OPENAI_API_KEY;
	const child = spawn(path.join(root, '.build/clean-host/ZSCode.Editor.exe'), ['--user-data-dir', path.join(run, 'user'), '--extensions-dir', path.join(run, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', `--remote-debugging-port=${port}`, workspaces[0].folder], { env, windowsHide: true, stdio: 'ignore' });
	let browser;
	try {
		for (let attempt = 0; attempt < 80; attempt++) {
			try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await pause(500); }
		}
		assert.ok(browser, 'Editor CDP must become available');
		const page = browser.contexts()[0].pages()[0];
		async function workspaceFrame(active) {
			for (let attempt = 0; attempt < 100; attempt++) {
				for (const frame of page.frames()) {
					try { if (await frame.locator('#workspaces .card.active h3').textContent({ timeout: 100 }) === `Progetto ${active}`) { return frame; } } catch { /* Frame may be replaced during reload. */ }
				}
				await pause(300);
			}
			throw new Error(`Workspace ${active} did not become active`);
		}
		let frame = await workspaceFrame('A');
		await page.screenshot({ path: path.join(root, '.build/workspaces-native.png') });
		await frame.locator('#workspaces .card').filter({ hasText: 'Progetto B' }).getByText('Apri Workspace', { exact: true }).click();
		frame = await workspaceFrame('B');
		assert.ok(await frame.locator('#workspaces .card.active').textContent().then(text => text.includes('Account B') && text.includes('Environment B')));
		const globalProfiles = JSON.parse(await fs.readFile(path.join(registry, 'profiles.json'), 'utf8'));
		const globalEnvironments = JSON.parse(await fs.readFile(path.join(registry, 'environments.json'), 'utf8'));
		assert.deepEqual([globalProfiles.activeProfileId, globalEnvironments.activeProfileId], ['a', 'a']);
		await page.screenshot({ path: path.join(root, '.build/workspaces-native-switched.png') });
		await fs.writeFile(path.join(root, '.build/workspaces-runtime-report.json'), JSON.stringify({ passed: true, checks: ['actual Workspace webview', 'dummy account A authentication', 'same-window folder switch', 'dummy account B authentication', 'environment B applied', 'global defaults preserved'] }));
		console.log('PASS: real editor, folder/account/environment switch, global defaults preserved');
	} finally {
		await browser?.close();
		spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
