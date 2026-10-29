/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = process.env.ZILPIO_TRELLO_LIVE === '1';

(async () => {
	const run = await fs.mkdtemp(path.join(root, '.build/trello-runtime-'));
	const folder = path.join(run, 'Project');
	await fs.mkdir(folder);
	await fs.mkdir(path.join(run, 'user/User'), { recursive: true });
	await fs.mkdir(path.join(run, 'registry'));
	await fs.writeFile(path.join(run, 'registry/profiles.json'), JSON.stringify({ version: 1, activeProfileId: null, profiles: [] }));
	await fs.writeFile(path.join(run, 'user/User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'chatgpt.openOnStartup': false }));
	const env = { ...process.env, ZILPIO_PROFILES_ROOT: path.join(run, 'registry') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ZILPIO_LAUNCHER;
	let app;
	try {
		app = await _electron.launch({ executablePath: path.join(root, '.build/clean-host/ZSCode.Editor.exe'), args: ['--user-data-dir', path.join(run, 'user'), '--extensions-dir', path.join(run, 'extensions'), '--disable-extension', 'openai.chatgpt', '--disable-extension', 'zilpio.zilpio-codex-notifier', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', folder], env, timeout: 30000 });
		const page = await app.firstWindow();
		await page.locator('.monaco-workbench').waitFor({ timeout: 30000 });
		await app.evaluate(({ session, shell }, { live, run }) => {
			if (live) { return; }
			global.__trelloExternal = [];
			global.__trelloMoved = false; global.__trelloDownloads = 0; global.__trelloCardChecks = 0;
			shell.openExternal = async url => { global.__trelloExternal.push(url); };
			const html = `<!doctype html><html><head><title>Trello fixture</title></head><body style="background:#e4f0fa;font:18px system-ui;padding:24px"><h1>Board del progetto</h1><button data-testid="header-boards-menu-button">Altre board</button><a id="other" href="https://trello.com/b/Other123">Altra board</a><br><a id="card" href="https://trello.com/c/Card1234/task">Card della board</a><br><a id="foreign" href="https://trello.com/c/Other123/task">Card estranea</a><br><a id="external" href="https://example.com/doc">Documento esterno</a><br><a id="login" href="https://id.atlassian.com/login">Login</a><br><a id="download" href="https://trello.com/1/cards/012345678901234567890123/attachments/012345678901234567890123/download/test.txt">Allegato</a><input id="edit" placeholder="Modifica card"><input id="file" type="file"></body></html>`;
			session.fromPartition('persist:zilpio-trello').on('will-download', (_event, item) => { global.__trelloDownloads++; item.setSavePath(run + '/attachment.txt'); });
			session.fromPartition('persist:zilpio-trello').protocol.handle('https', request => {
				const url = new URL(request.url);
				if (url.pathname.includes('/attachments/')) { return new Response('Attachment fixture', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="test.txt"' } }); }
				if (url.pathname.startsWith('/1/cards/')) { global.__trelloCardChecks++; return new Response(JSON.stringify({ id: '012345678901234567890123', shortLink: 'Card1234', idBoard: global.__trelloMoved || url.pathname.includes('Other123') ? '000000000000000000000000' : '123456789012345678901234' }), { headers: { 'Content-Type': 'application/json' } }); }
				if (url.pathname.startsWith('/1/boards/')) { return new Response(JSON.stringify({ id: '123456789012345678901234', cards: [{ id: '012345678901234567890123', shortLink: 'Card1234', idBoard: '123456789012345678901234' }, { shortLink: 'Other123', idBoard: '000000000000000000000000' }] }), { headers: { 'Content-Type': 'application/json' } }); }
				if (url.hostname === 'id.atlassian.com' && url.pathname === '/login/authorize') {
					const target = url.searchParams.has('foreign') ? 'https://trello.com/b/Other123' : 'https://trello.com/bridge/complete?code=fixture&state=fixture';
					return url.searchParams.has('http') ? Response.redirect(target) : new Response(`<script>location.replace(${JSON.stringify(target)})</script>`, { headers: { 'Content-Type': 'text/html' } });
				}
				if (url.hostname === 'id.atlassian.com') { return new Response('<h1>Login fixture</h1><a id="return" href="https://trello.com/">Torna a Trello</a><a id="complete" href="/login/authorize">Completa accesso</a><a id="callback" href="https://trello.com/bridge/complete?code=fixture&amp;state=fixture">Ritorno diretto</a>', { headers: { 'Content-Type': 'text/html' } }); }
				if (url.pathname === '/bridge/complete') { return new Response('<script>document.cookie="callback-session=complete; Secure; SameSite=Lax; path=/"; location.replace("/b/AbCd1234");</script>', { headers: { 'Content-Type': 'text/html' } }); }
				return new Response(html, { headers: { 'Content-Type': 'text/html' } });
			});
		}, { live, run });
		await page.locator('.statusbar-item').filter({ hasText: 'Trello' }).click({ timeout: 20000 });
		let frame;
		for (let attempt = 0; attempt < 100; attempt++) {
			for (const candidate of page.frames()) { if (await candidate.locator('#board-url').count()) { frame = candidate; break; } }
			if (frame) { break; }
			frame = undefined; await pause(200);
		}
		if (!frame) {
			await page.screenshot({ path: path.join(root, '.build/trello-runtime-failure.png') });
			console.log('Workbench diagnostic:', await page.locator('body').innerText(), page.frames().map(f => f.url()));
		}
		assert.ok(frame, 'Trello page must open in the real workbench');
		await frame.locator('#board-url').fill(live ? 'https://trello.com/b/qf0lM7k8' : 'https://trello.com/b/AbCd1234/project');
		await frame.locator('#save').click();
		const native = async script => app.evaluate(async ({ BrowserWindow }, script) => {
			const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('vscode-file:'));
			const contents = window?.contentView.children.find(view => view.webContents?.getURL().startsWith('https://trello.com/') || view.webContents?.getURL().startsWith('https://id.atlassian.com/'))?.webContents;
			return contents ? contents.executeJavaScript(script) : null;
		}, script);
		const until = async (fn, message) => {
			const deadline = Date.now() + (live ? 30000 : 12000);
			while (Date.now() < deadline) { if (await fn()) { return; } await pause(150); }
			throw new Error(message);
		};
		if (live) {
			await until(() => native('document.querySelectorAll(`a[href*="/c/"]`).length > 0'), 'Public Trello board must render real card links');
			const before = await native('({ title: document.title, path: location.pathname, cards: document.querySelectorAll(`a[href*="/c/"]`).length })');
			await native('document.querySelector(`a[href*="/c/"]`).click()');
			await until(async () => /^\/c\//.test(await native('location.pathname')), 'A card on the real public board must open');
			await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(view => view.webContents?.getURL().startsWith('https://trello.com/') && view.getVisible())), 'Real Trello content must be visible inside the editor');
			await until(() => native('document.querySelector(`[data-testid="card-back"]`) !== null || document.querySelector(`[role="dialog"]`) !== null'), 'Real Trello card dialog must render');
			const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
			await fs.writeFile(path.join(root, '.build/trello-live.png'), Buffer.from(image, 'base64'));
			const nativeImage = await app.evaluate(async ({ webContents }) => (await webContents.getAllWebContents().find(w => w.getURL().startsWith('https://trello.com/')).capturePage()).toPNG().toString('base64'));
			await fs.writeFile(path.join(root, '.build/trello-live-native.png'), Buffer.from(nativeImage, 'base64'));
			await fs.writeFile(path.join(root, '.build/trello-live-report.json'), JSON.stringify({ passed: true, before, cardPath: await native('location.pathname'), authenticated: false, writes: false }, null, 2));
			console.log('PASS: real public Trello board rendered and card opened; anonymous, read-only');
			return;
		}
		await until(() => native('document.querySelector("#card") !== null'), 'Native Trello view must load');
		console.log('Native view loaded');
		assert.equal(await native('getComputedStyle(document.querySelector("[data-testid=header-boards-menu-button]")).display'), 'none');
		await native('document.querySelector("#other").click()');
		assert.equal(await native('(() => { try { history.pushState({}, "", "/b/Other123"); return true; } catch { return false; } })()'), false, 'Rejected SPA navigation must abort the router instead of reporting success');
		assert.equal(await native('location.pathname'), '/b/AbCd1234');
		await native('document.querySelector("#foreign").click()'); await pause(400);
		assert.equal(await native('location.pathname'), '/b/AbCd1234');
		await native('document.querySelector("#external").click()');
		assert.deepEqual(await app.evaluate(() => global.__trelloExternal), ['https://example.com/doc']);
		await native('document.querySelector("#card").click()');
		await until(async () => (await native('location.pathname')) === '/c/Card1234/task', 'Verified card must remain usable');
		await native('document.querySelector("#edit").value = "Card modificata"');
		assert.equal(await native('document.querySelector("#edit").value'), 'Card modificata');
		await native('document.querySelector("#download").click()');
		await until(async () => { try { return await fs.readFile(path.join(run, 'attachment.txt'), 'utf8') === 'Attachment fixture'; } catch { return false; } }, 'Board attachment must download with the embedded session');
		await native('location.href = "https://trello.com/b/Other123"'); await pause(300);
		assert.equal(await native('location.pathname'), '/c/Card1234/task');
		await native('window.open("https://trello.com/b/Other123")'); await pause(300);
		assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
		await native('history.pushState({}, "", "/b/AbCd1234")');
		await app.evaluate(() => { global.__trelloMoved = true; });
		await native('document.querySelector("#card").click()'); await pause(500);
		assert.equal(await native('location.pathname'), '/b/AbCd1234', 'A card moved off this board must not remain permitted by the cache');
		await native('document.querySelector("#download").click()'); await pause(500);
		assert.equal(await app.evaluate(() => global.__trelloDownloads), 1, 'Attachments of moved cards must no longer download');
		await app.evaluate(() => { global.__trelloMoved = false; });
		for (const handoff of ['document.querySelector("#complete").click()', 'location.href = "/login/authorize?http=1"', 'document.querySelector("#callback").click()']) {
			await app.evaluate(async ({ session }) => { await session.fromPartition('persist:zilpio-trello').cookies.remove('https://trello.com', 'callback-session'); });
			await native('document.querySelector("#login").click()');
			await until(async () => (await native('location.hostname')) === 'id.atlassian.com', 'Authentication must be allowed');
			await native(handoff);
			await until(async () => (await native('location.pathname')) === '/b/AbCd1234', 'Callback must finish before returning to the linked board');
			assert.ok((await native('document.cookie')).includes('callback-session=complete'), `The callback must establish the Trello session before the board reloads: ${handoff}`);
		}
		await native('location.href = "https://trello.com/bridge/complete"'); await pause(300);
		assert.equal(await native('location.pathname'), '/b/AbCd1234', 'The callback exception must be cleared after returning to the board');
		await native('document.querySelector("#login").click()');
		await until(async () => (await native('location.hostname')) === 'id.atlassian.com', 'Authentication must be allowed');
		await native('location.href = "/login/authorize?foreign=1"');
		await until(async () => (await native('location.pathname')) === '/b/AbCd1234', 'An authentication redirect must not allow another board');
		await native('document.querySelector("#login").click()');
		await until(async () => (await native('location.hostname')) === 'id.atlassian.com', 'Authentication must be allowed');
		await native('document.querySelector("#return").click()');
		await until(async () => (await native('location.pathname')) === '/b/AbCd1234', 'Authentication must return to the linked board');
		await native('void window.open("https://id.atlassian.com/login", "login")');
		await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().startsWith('https://id.atlassian.com/'))), 'Authentication popup must be usable');
		await app.evaluate(async ({ BrowserWindow, session }) => {
			await session.fromPartition('persist:zilpio-trello').cookies.set({ url: 'https://trello.com', name: 'fixture-session', value: 'persistent', sameSite: 'lax' });
			BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('https://id.atlassian.com/')).close();
		});
		await until(async () => (await native('location.pathname')) === '/b/AbCd1234', 'Closing login must return focus to the linked board');
		assert.ok((await native('document.cookie')).includes('fixture-session=persistent'), 'Login and board must share the persistent session');
		await app.evaluate(async ({ session }) => { await session.fromPartition('persist:zilpio-trello').cookies.remove('https://trello.com', 'callback-session'); });
		await native('void window.open("https://id.atlassian.com/login/authorize?http=1", "direct-login")');
		await until(async () => (await native('document.cookie'))?.includes('callback-session=complete'), 'An initial authentication popup redirect must execute the callback and share its session');
		await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('https://trello.com/'))?.close(); });
		await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1), 'Authentication popup must close before resuming workbench checks');
		await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('vscode-file:'))?.contentView.children.some(view => view.webContents?.getURL().startsWith('https://trello.com/') && view.getVisible())), 'Board must become visible after completing popup login');
		console.log('Board lock, verified cards, external links and authentication passed');
		const bounds = await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0];
			return window.contentView.children.map(view => ({ visible: view.getVisible(), bounds: view.getBounds() }));
		});
		assert.ok(bounds.some(view => view.visible && view.bounds.y > 40 && view.bounds.width > 200 && view.bounds.height > 200), 'Native view must fit below the page toolbar');
		await page.locator('.tab').filter({ hasText: 'Codex' }).click();
		await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every(view => !view.webContents || !view.webContents.getURL().startsWith('https://trello.com') || !view.getVisible())), 'Native view must hide when another editor is selected');
		await page.locator('.tab').filter({ hasText: 'Trello' }).click();
		await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some(view => view.webContents?.getURL().startsWith('https://trello.com') && view.getVisible())), 'Native view must return when its editor is selected');
		await page.keyboard.press('F1');
		await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every(view => !view.webContents || !view.webContents.getURL().startsWith('https://trello.com') || !view.getVisible())), 'Native view must hide behind the command palette');
		await page.keyboard.press('Escape');
		await frame.locator('#change').click();
		await frame.locator('#board-url').fill('https://trello.com/b/NewB1234');
		await frame.locator('#save').click();
		await until(async () => (await native('location.pathname')) === '/b/NewB1234', 'Explicit board reassignment must work');
		const stored = JSON.parse(await fs.readFile(path.join(run, 'registry/trello.json'), 'utf8'));
		assert.equal(stored.boards[folder.toLowerCase()], 'https://trello.com/b/NewB1234');
		await frame.locator('#change').click();
		await frame.locator('#remove').click();
		await until(async () => await frame.locator('#connect').isVisible(), 'Removing the association must show the link form');
		await page.keyboard.press('Control+w'); await pause(600);
		assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some(w => w.getURL().startsWith('https://trello.com/'))), false, 'Closing the editor must destroy its native view');
		await fs.writeFile(path.join(root, '.build/trello-runtime-report.json'), JSON.stringify({ passed: true, checks: ['real extension page', 'native Electron view', 'folder persistence', 'normal and SPA board lock', 'foreign card rejected', 'moved card reopening and attachment rejected', 'verified card editable', 'attachment download', 'external browser links', 'foreign board popup rejected', 'login popup and persistent cookies', 'login and return', 'toolbar bounds', 'hide and restore with editor tabs', 'command palette overlay', 'explicit reassignment', 'unlink and dispose'] }, null, 2));
		console.log('PASS: Trello integration in the real editor; controlled HTTPS fixtures, no real account access');
	} finally { await app?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
