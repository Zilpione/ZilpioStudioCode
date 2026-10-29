const { chromium } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');

function html() {
	let content;
	const panel = { webview: { cspSource: '', asWebviewUri: uri => uri, set html(value) { content = value; }, onDidReceiveMessage: () => ({ dispose() {} }) }, onDidDispose: () => ({ dispose() {} }) };
	const loaded = { exports: {} };
	vm.runInNewContext(fs.readFileSync(path.join(root, 'extensions/zilpio-codex/workspace-page.js'), 'utf8'), {
		module: loaded, queueMicrotask,
		require: name => name === 'vscode' ? {
			Uri: { joinPath: (_, ...parts) => parts.join('/') }, ViewColumn: { One: 1 },
			commands: { registerCommand: () => ({ dispose() {} }) },
			window: { createWebviewPanel: () => panel, tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) } }
		} : require(name)
	});
	loaded.exports.activate({ extensionUri: '', subscriptions: [] });
	return content.replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '').replace(/<link[^>]+>/, '').replace(/<script[^>]+><\/script>/, '');
}

(async () => {
	const browser = await chromium.launch({ channel: 'msedge', headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1080, height: 820 } });
		await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: html() }));
		await page.goto('http://localhost/');
		await page.addStyleTag({ path: path.join(root, 'extensions/zilpio-codex/media/workspaces.css') });
		await page.evaluate(() => {
			window.db = { workspaces: [
				{ id: 'a', name: 'Zilpio Studio', folder: 'Z:\\Projects\\ExampleEditor', accountId: 'a', environmentId: 'e', color: '#8d9aff' },
				{ id: 'b', name: 'Portale Clienti', folder: 'D:\\Progetti\\Portale', accountId: 'b', environmentId: 'f', color: '#54c5ac' },
				{ id: 'c', name: 'Laboratorio', folder: 'D:\\Progetti\\Lab', accountId: 'a', environmentId: 'f', color: '#e9af69' }
			], usageCards: [{ id: 'u', name: 'Personale', accountId: 'a', color: '#8d9aff' }, { id: 'v', name: 'Lavoro', accountId: 'b', color: '#54c5ac' }], profiles: [{ id: 'a', name: 'Personale' }, { id: 'b', name: 'Lavoro' }], environments: [{ id: 'e', name: 'Work' }, { id: 'f', name: 'Codex' }], busy: false, activeId: 'a' };
			window.calls = [];
			window.acquireVsCodeApi = () => ({ postMessage: message => {
				window.calls.push(message);
				let result;
				if (message.action === 'list') { result = structuredClone(window.db); }
				if (message.action === 'browse') { result = 'D:\\Progetti\\Nuovo'; }
				if (message.action === 'usage') { result = [{ usedPercent: message.accountId === 'a' ? 24 : 68, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, { usedPercent: message.accountId === 'a' ? 41 : 90, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }]; }
				if (message.action === 'save') { const cards = window.db[message.kind], index = cards.findIndex(c => c.id === message.card.id); if (index < 0) { cards.push(message.card); } else { cards[index] = message.card; } }
				if (message.action === 'delete') { window.db[message.kind] = window.db[message.kind].filter(c => c.id !== message.id); }
				queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { requestId: message.requestId, result } })));
			} });
		});
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/workspaces.js') });
		await page.waitForFunction(() => document.querySelectorAll('[role=progressbar]').length === 4);
		assert.equal(await page.locator('.card.active').count(), 1);
		const firstCard = page.locator('#workspaces .card').first();
		await firstCard.getByRole('button', { name: 'Apri Cartella', exact: true }).click();
		await page.waitForFunction(() => window.calls.some(call => call.action === 'openFolder'));
		await firstCard.getByRole('button', { name: 'Apri Workspace', exact: true }).click();
		await page.waitForFunction(() => window.calls.some(call => call.action === 'select'));
		assert.deepEqual(await page.evaluate(() => window.calls.filter(call => ['openFolder', 'select'].includes(call.action)).map(({ action, id }) => ({ action, id }))), [{ action: 'openFolder', id: 'a' }, { action: 'select', id: 'a' }]);
		assert.deepEqual(await page.locator('[role=progressbar]').evaluateAll(bars => bars.map(b => b.getAttribute('aria-valuenow'))), ['76', '59', '32', '10']);
		assert.deepEqual(await page.locator('.fill').evaluateAll(bars => bars.map(b => b.dataset.level)), ['high', 'high', 'medium', 'low']);
		assert.ok(await page.locator('#usageCards').evaluate(grid => grid.getBoundingClientRect().bottom < 650));
		await page.screenshot({ path: path.join(root, '.build/workspaces-desktop.png') });
		await page.locator('#add-workspace').click();
		await page.locator('#name').fill('<img src=x onerror=alert(1)>');
		await page.locator('#browse').click();
		await page.waitForFunction(() => document.getElementById('folder').value === 'D:\\Progetti\\Nuovo');
		await page.locator('button[type=submit]').click();
		await page.waitForFunction(() => document.querySelectorAll('#workspaces .card').length === 4);
		assert.equal(await page.locator('img').count(), 0);
		await page.locator('#workspaces .card').last().getByRole('button', { name: /^Modifica / }).click();
		await page.locator('#name').fill('Nuovo Progetto'); await page.locator('button[type=submit]').click();
		await page.locator('#workspaces .card').last().getByRole('button', { name: /^Elimina / }).click();
		await page.waitForFunction(() => document.querySelectorAll('#workspaces .card').length === 3);
		await page.locator('#add-usage').click(); await page.locator('#name').fill('Secondo account'); await page.locator('#account').selectOption('b'); await page.locator('button[type=submit]').click();
		await page.waitForFunction(() => document.querySelectorAll('#usageCards .card').length === 3);
		await page.locator('#usageCards .card').last().getByRole('button', { name: /^Elimina / }).click();
		await page.waitForFunction(() => document.querySelectorAll('#usageCards .card').length === 2);
		await page.evaluate(() => { window.db.busy = true; }); await page.locator('#refresh').click();
		await page.waitForFunction(() => [...document.querySelectorAll('.open-folder, .open-workspace')].every(b => b.disabled));
		assert.equal(await page.locator('#notice').isVisible(), true);
		await page.setViewportSize({ width: 390, height: 850 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		for (const card of await page.locator('#workspaces .card').all()) {
			const folder = await card.locator('.open-folder').boundingBox(), workspace = await card.locator('.open-workspace').boundingBox();
			assert.ok(folder.width > workspace.width && folder.x + folder.width <= workspace.x && Math.abs(folder.y + folder.height / 2 - workspace.y - workspace.height / 2) < 1);
		}
		await page.screenshot({ path: path.join(root, '.build/workspaces-narrow.png'), fullPage: true });
		console.log('PASS: cards, usage, CRUD, safe text, busy block, responsive layout');
	} finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
