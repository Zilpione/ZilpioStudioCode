const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
	const root = path.resolve(__dirname, '../..');
	const browser = await chromium.launch({ channel: 'msedge', headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 680, height: 970 } });
		await page.setContent(`<style>body{margin:0;background:#181818;color:#eee;font:12px sans-serif}.retained{display:none}.route{position:fixed;bottom:12px;left:12px;right:12px}form{padding:12px}textarea{display:block;width:95%;height:70px}button{color:inherit;background:transparent;border:0}</style>${['home', 'chat-a', 'chat-b'].map((id, i) => `<section id="${id}" class="route${i ? ' retained' : ''}"><form data-thread-find-composer><textarea>Bozza ${id}</textarea><div><button data-composer-navigation-target="permissions">Full access</button><button data-composer-navigation-target="reasoning">GPT model</button></div>${i ? '<div><button data-composer-navigation-target="run-location">Work locally</button></div>' : ''}</form></section>`).join('')}`);
		await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
		await page.addStyleTag({ path: path.join(root, 'extensions/zilpio-codex/media/official-usage.css') });
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/model-settings-ui.js') });
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/official-usage.js') });
		await page.evaluate(() => {
			window.acquireVsCodeApi();
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'zilpio-profiles-state', activeProfileId: 'a', profiles: [{ id: 'a', name: 'Account A' }, { id: 'b', name: 'Account B' }] } }));
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcp-notification', method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } } } } }));
		});
		const check = async id => {
			await page.waitForFunction(id => {
				const route = document.getElementById(id);
				return route.querySelector('.zilpio-account-selector')?.checkVisibility() && route.querySelector('.zilpio-model-settings-button')?.checkVisibility() && route.querySelectorAll('.zilpio-usage [role="progressbar"]').length === 2;
			}, id, { timeout: 3000 });
			const route = page.locator(`#${id}`);
			assert.equal(await page.locator('.zilpio-account-selector').count(), 1);
			assert.equal(await page.locator('.zilpio-model-settings-button').count(), 1);
			assert.equal(await page.locator('.zilpio-usage').count(), 1);
			assert.deepEqual(await route.locator('[role="progressbar"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-valuenow'))), ['80', '60']);
			assert.match(await route.locator('.zilpio-account-selector').textContent(), /Account A/);
			assert.equal(await route.locator('textarea').inputValue(), `Bozza ${id}`);
			assert.equal(await route.locator('[data-composer-navigation-target="permissions"]').getAttribute('data-zilpio-label'), 'Permessi');
			await route.locator('.zilpio-account-selector').click();
			assert.equal(await page.locator('.zilpio-account-menu').evaluate(node => node.matches(':popover-open')), true);
			await page.keyboard.press('Escape');
			await route.locator('.zilpio-model-settings-button').click();
			assert.equal(await page.locator('.zilpio-model-settings').evaluate(node => node.open), true);
			await page.getByRole('button', { name: 'Chiudi', exact: true }).click();
		};
		await check('home');
		for (const id of ['chat-a', 'home', 'chat-b', 'chat-a', 'chat-b', 'home', 'chat-a']) {
			// A hot route switch keeps all composers and only flips their CSS class.
			await page.evaluate(id => { for (const route of document.querySelectorAll('.route')) { route.classList.toggle('retained', route.id !== id); } }, id);
			await check(id);
		}
		await page.screenshot({ path: path.join(root, '.build/retained-chats-controls.png') });
		console.log('PASS: 7 retained chat/home switches; account, both quotas, model settings and permission labels follow the visible composer; drafts retained.');
	} finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
