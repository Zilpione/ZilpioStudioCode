const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
	const root = path.resolve(__dirname, '../..');
	const browser = await chromium.launch({ channel: 'msedge', headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 460, height: 800 } });
		await page.setContent(`<style>body{margin:0;background:#181818;color:#eee;font:12px sans-serif}main{position:fixed;bottom:12px;left:12px;right:12px}form{padding:12px;border:1px solid #444;border-radius:16px}textarea{display:block;width:100%;height:64px;box-sizing:border-box}button{color:inherit;background:transparent;border:0}</style><main><form data-thread-find-composer><textarea placeholder="Do anything"></textarea><div><button data-composer-navigation-target="permissions">Full access</button><button data-composer-navigation-target="reasoning">GPT model</button></div></form></main>`);
		await page.evaluate(() => {
			const meta = document.createElement('meta'); meta.name = 'zilpio-startup'; meta.content = encodeURIComponent(JSON.stringify({ model: 'gpt-6-luna', reasoningEffort: 'high', serviceTier: 'default' })); document.head.append(meta);
		});
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/model-settings-ui.js') });
		assert.deepEqual(await page.evaluate(() => {
			const models = ['gpt-6-astra', 'gpt-6-luna'].map(model => ({ model, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }));
			window.zilpioFilterModels(models, { models, defaultModel: models[0] });
			const initial = window.zilpioStartupModel({ model: 'gpt-6-astra', reasoningEffort: 'medium' }, true);
			const tier = window.zilpioStartupTier('fast', true);
			window.zilpioModelSelected(); window.zilpioTierSelected();
			return [initial, tier, window.zilpioStartupModel({ model: 'gpt-6-astra', reasoningEffort: 'high' }, true), window.zilpioStartupTier('fast', true)];
		}), [{ model: 'gpt-6-luna', reasoningEffort: 'high' }, 'default', { model: 'gpt-6-astra', reasoningEffort: 'high' }, 'fast']);
		await page.evaluate(() => { delete window.zilpioActiveModel; });
		await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: () => {} }); });
		await page.addStyleTag({ path: path.join(root, 'extensions/zilpio-codex/media/official-usage.css') });
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/official-usage.js') });
		await page.evaluate(() => {
			window.acquireVsCodeApi();
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'zilpio-profiles-state', activeProfileId: 'a', profiles: [{ id: 'a', name: 'Account A' }, { id: 'b', name: 'Account B' }] } }));
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcp-notification', method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } } } } }));
		});
		const check = async name => {
			await page.waitForFunction(() => document.querySelectorAll('.zilpio-usage [role="progressbar"]').length === 2 && document.querySelector('.zilpio-account-selector')?.getBoundingClientRect().top > 400);
			const state = await page.evaluate(() => ({ count: document.querySelectorAll('.zilpio-account-selector').length, bars: [...document.querySelectorAll('.zilpio-usage [role="progressbar"]')].map(bar => bar.getAttribute('aria-valuenow')), inComposer: !!document.querySelector('.zilpio-account-selector').closest('form') }));
			assert.equal(state.count, 1); assert.equal(state.inComposer, true); assert.deepEqual(state.bars, ['80', '60']);
			await page.screenshot({ path: path.join(root, `.build/controls-${name}.png`) });
		};
		await check('home');
		const color = async (data, expected) => {
			await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
			assert.deepEqual(await page.evaluate(() => {
				const composer = document.querySelector('form[data-thread-find-composer] textarea');
				const style = getComputedStyle(composer);
				return { color: style.outlineColor, width: style.outlineWidth, belowHistory: composer.getBoundingClientRect().top > 400, windowBorder: getComputedStyle(document.body, '::after').content };
			}), { color: expected, width: '2px', belowHistory: true, windowBorder: 'none' });
		};
		await color({ type: 'zilpio-profiles-state', workspaceColor: '#7c8aff', profiles: [] }, 'rgb(124, 138, 255)');
		await page.screenshot({ path: path.join(root, '.build/workspace-chat-outline.png') });
		await color({ type: 'zilpio-workspace-color', color: '#ff1234' }, 'rgb(255, 18, 52)');
		await color({ type: 'zilpio-workspace-color', color: null }, 'rgba(0, 0, 0, 0)');
		await color({ type: 'zilpio-workspace-color', color: 'red; background: red' }, 'rgba(0, 0, 0, 0)');
		await page.locator('.zilpio-account-selector').click();
		assert.equal(await page.locator('.zilpio-account-menu').evaluate(menu => menu.matches(':popover-open')), true);
		const menu = await page.locator('.zilpio-account-menu').boundingBox(), button = await page.locator('.zilpio-account-selector').boundingBox();
		assert.ok(menu.y + menu.height <= button.y);
		await page.keyboard.press('Escape');
		await page.evaluate(() => { document.querySelector('form').innerHTML = '<textarea></textarea><div><button data-composer-navigation-target="permissions">Full access</button><button data-composer-navigation-target="reasoning">GPT model</button></div><div><button data-composer-navigation-target="run-location">Work locally</button></div>'; });
		await check('chat');
		await page.evaluate(() => { document.querySelector('[data-composer-navigation-target="run-location"]').parentElement.remove(); });
		await check('home-again');
		await page.evaluate(() => {
			const form = document.querySelector('form');
			const surface = document.createElement('div'); surface.dataset.composerSurfaceVariant = 'default'; surface.innerHTML = '<textarea></textarea><div><button data-composer-navigation-target="permissions">Permissions</button><button data-composer-navigation-target="reasoning" data-zilpio-model="Luna" data-selected-reasoning-effort="high">◉</button></div>';
			form.replaceWith(surface);
		});
		await page.waitForFunction(() => document.querySelector('[data-composer-surface-variant] .zilpio-account-selector')?.checkVisibility());
		assert.equal(await page.locator('[data-composer-surface-variant] .zilpio-usage [role="progressbar"]').count(), 2);
		await page.evaluate(() => { window.zilpioActiveModel = { model: 'gpt-6-luna', reasoningEffort: 'high' }; window.dispatchEvent(new Event('zilpio-model-changed')); });
		await page.waitForFunction(() => /gpt-6-luna.*high/.test(document.querySelector('.zilpio-current-model')?.textContent || ''));
		await page.evaluate(() => document.querySelector('[data-composer-navigation-target="reasoning"]').addEventListener('click', () => { window.modelPickerOpened = true; }));
		await page.locator('.zilpio-current-model').click();
		assert.equal(await page.evaluate(() => window.modelPickerOpened), true);
		await fs.writeFile(path.join(root, '.build/controls-layout-report.json'), JSON.stringify({ passed: true, checks: ['home footer', 'chat footer', 'return to home', 'two quota bars retained', 'account menu opens above its button'] }));
		console.log('PASS: home, chat, return to home, quota bars, anchored menu');
	} finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
