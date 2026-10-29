const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ModelSettings } = require('../../extensions/zilpio-codex/model-settings.js');
(async () => {
	const root = path.resolve(__dirname, '../..');
	const catalog = JSON.parse(fs.readFileSync(path.join(root, '.build/models-catalog-smoke.json'), 'utf8')).catalog;
	const browser = await chromium.launch({ channel: 'msedge', headless: true });
	const store = new ModelSettings(path.join(root, '.build/model-settings-ui-test'), async () => ({ data: catalog, nextCursor: null }));
	await require('node:fs/promises').unlink(store.file).catch(error => { if (error.code !== 'ENOENT') { throw error; } });
	try {
		const page = await browser.newPage({ viewport: { width: 460, height: 850 } });
		await page.setContent('<style>body{background:#181818;color:#eee}form{position:absolute;bottom:20px}</style><form data-thread-find-composer><textarea>Bozza da conservare</textarea><button data-composer-navigation-target="model">Modello</button></form>');
		let lastSave;
		await page.exposeFunction('modelsBridge', async message => {
			if (message.type !== 'zilpio-models') { return; }
			let preferences = await store.load(), error;
			try { if (message.action === 'save') { lastSave = message; preferences = await store.save(message.models, catalog); } }
			catch (e) { error = e.message; }
			await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), { type: 'zilpio-models-state', requestId: message.requestId, catalog, profileId: 'test', preferences, saved: message.action === 'save' && !error, error });
		});
		await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.modelsBridge(message) }); });
		await page.addStyleTag({ path: path.join(root, 'extensions/zilpio-codex/media/official-usage.css') });
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/model-settings-ui.js') });
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/official-usage.js') });
		await page.evaluate(catalog => {
			window.zilpioFilterModels(catalog, { models: [catalog[0]], defaultModel: catalog[0] });
			window.refreshCount = 0; window.zilpioRefreshModels = () => window.refreshCount++;
			window.acquireVsCodeApi();
		}, catalog);
		await page.getByRole('button', { name: 'Impostazioni modelli ed effort' }).click();
		await page.waitForFunction(() => document.querySelectorAll('.zilpio-model-list fieldset').length === 10);
		const chosen = page.locator(`fieldset[data-model="${catalog[0].model}"]`);
		for (const effort of catalog[0].supportedReasoningEfforts) { await chosen.locator(`input[data-effort="${effort.reasoningEffort}"]`).uncheck(); }
		await page.getByRole('button', { name: 'Salva', exact: true }).click();
		await page.getByRole('status').filter({ hasText: 'Scegli almeno un effort' }).waitFor();
		await chosen.locator('input[data-effort="high"]').check();
		const second = page.locator(`fieldset[data-model="${catalog[1].model}"]`);
		await second.locator('legend input').check();
		await page.evaluate(catalog => window.dispatchEvent(new MessageEvent('message', { data: { type: 'zilpio-models-state', requestId: 'background', catalog, profileId: 'test', preferences: null } })), catalog);
		assert.equal(await second.locator('legend input').isChecked(), true);
		assert.equal(await chosen.locator('input[data-effort="high"]').isChecked(), true);
		await page.getByRole('button', { name: `Metti in blacklist ${catalog[2].displayName}` }).click();
		assert.equal(await page.locator('.zilpio-model-blacklist-section').evaluate(node => node.open), false);
		assert.equal(await page.locator('.zilpio-model-blacklist-section fieldset').count(), 1);
		await page.screenshot({ path: path.join(root, '.build/model-settings-panel.png') });
		await page.getByRole('button', { name: 'Salva', exact: true }).click();
		await page.waitForFunction(() => !document.querySelector('.zilpio-model-settings').open);
		assert.equal(lastSave.profileId, 'test');
		assert.deepEqual(lastSave.models[catalog[0].model].efforts, ['high']);
		assert.equal(await page.locator('textarea').inputValue(), 'Bozza da conservare');
		const selected = await page.evaluate(catalog => window.zilpioFilterModels(catalog, { models: [catalog[0]], defaultModel: catalog[0] }), catalog);
		assert.equal(selected.models.length, 2); assert.deepEqual(selected.models[0].supportedReasoningEfforts.map(e => e.reasoningEffort), ['high']);
		assert.equal(lastSave.models[catalog[2].model].blacklisted, true);
		assert.equal((await new ModelSettings(path.join(root, '.build/model-settings-ui-test')).load()).models[catalog[2].model].blacklisted, true);
		assert.ok(await page.evaluate(() => window.refreshCount > 0));
		await page.getByRole('button', { name: 'Impostazioni modelli ed effort' }).click();
		await page.locator('.zilpio-model-blacklist-section summary').click();
		await page.getByRole('button', { name: `Ripristina ${catalog[2].displayName}` }).click();
		assert.equal(await page.locator('.zilpio-model-blacklist-section fieldset').count(), 0);
		await page.getByRole('button', { name: 'Chiudi', exact: true }).click();
		console.log('PASS: multiple models/efforts, background responses preserve edits, persistent collapsed blacklist and restore, live picker refresh, draft preserved.');
	} finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
