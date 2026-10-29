const { chromium } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
	const root = path.resolve(__dirname, '../..');
	const browser = await chromium.launch({ channel: 'msedge', headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 460, height: 800 } });
		await page.setContent('<style>body{margin:0;background:#181818;color:#eee;font:12px sans-serif}form{position:absolute;bottom:20px;left:10px;right:10px}textarea{display:block;width:95%;height:60px}.retained{display:none}</style><form data-thread-find-composer><textarea>Bozza da conservare</textarea><button data-composer-navigation-target="model">Modello</button></form>');
		await page.evaluate(() => {
			window.sent = [];
			window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message), setState: value => { window.savedRoute = value; } });
		});
		await page.addStyleTag({ path: path.join(root, 'extensions/zilpio-codex/media/official-usage.css') });
		for (const file of ['model-settings-ui.js', 'environments-ui.js', 'official-usage.js']) {
			await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media', file) });
		}
		const state = { type: 'zilpio-environments-state', activeEnvironmentId: 'work', environments: [{ id: 'work', name: 'Work', home: 'C:\\user\\.codex-work' }, { id: 'codex', name: 'Codex', home: 'C:\\user\\.codex' }] };
		await page.evaluate(state => { window.acquireVsCodeApi(); window.dispatchEvent(new MessageEvent('message', { data: state })); }, state);
		const button = page.getByRole('button', { name: 'Scegli environment delle chat' });
		assert.equal(await button.textContent(), 'Environment: Work ▾');
		assert.equal(await button.evaluate(node => node.previousElementSibling.className), 'zilpio-model-settings-button');
		await button.click();
		assert.equal(await page.getByRole('menuitemradio', { name: /Work/ }).getAttribute('aria-checked'), 'true');
		await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { type: 'zilpio-environments', action: 'select', environmentId: 'codex' });
		assert.equal(await button.isDisabled(), true);
		await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { ...state, error: 'Turno attivo' } })), state);
		assert.equal(await button.isEnabled(), true); assert.equal(await button.getAttribute('title'), 'Turno attivo');
		await button.click(); await page.getByRole('menuitem', { name: 'Modifica impostazioni…' }).click();
		assert.equal(await page.evaluate(() => window.sent.at(-1).action), 'edit');
		await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
		await button.click(); await page.getByRole('menuitem', { name: 'Nuovo environment…' }).click();
		assert.equal(await page.evaluate(() => window.sent.at(-1).action), 'new');
		state.environments[0].name = 'Lavoro';
		await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
		assert.equal(await button.textContent(), 'Environment: Lavoro ▾');
		await page.evaluate(() => {
			document.querySelector('form').className = 'retained';
			const form = document.createElement('form'); form.dataset.threadFindComposer = '';
			form.innerHTML = '<textarea>Seconda bozza</textarea><div style="display:flex;flex-wrap:wrap"><button data-composer-navigation-target="run-location">Work locally</button></div>';
			document.body.append(form);
		});
		await page.waitForFunction(() => document.querySelector('.zilpio-environment-selector').closest('form')?.className !== 'retained');
		assert.equal(await page.locator('.zilpio-environment-selector').count(), 1);
		assert.equal(await page.locator('form.retained textarea').inputValue(), 'Bozza da conservare');
		await page.setViewportSize({ width: 320, height: 700 });
		await button.click();
		const box = await page.getByRole('menu', { name: 'Environment Codex', exact: true }).boundingBox();
		assert.ok(box.x >= 0 && box.x + box.width <= 320);
		await page.screenshot({ path: path.join(root, '.build/environment-selector.png') });
		await page.evaluate(() => {
			window.savedRoute = '/local/old-environment-thread';
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'zilpio-environments-reset', requestId: 'reset-1' } }));
		});
		await page.waitForFunction(() => window.sent.at(-1).action === 'reset-complete');
		assert.equal(await page.evaluate(() => window.savedRoute), undefined);
		assert.equal(await page.evaluate(() => window.sent.at(-1).requestId), 'reset-1');
		console.log('PASS: environment next to Models, seeds, keyboard selection, edit, nicknames, errors, retained composers and narrow viewport.');
	} finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
