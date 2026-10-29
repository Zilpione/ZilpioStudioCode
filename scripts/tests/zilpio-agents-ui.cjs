/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { chromium } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentStore } = require('../../extensions/zilpio-codex/agents.js');
(async () => {
	const root = path.resolve(__dirname, '../..'), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-agents-ui-'));
	const store = new AgentStore(temp), home = path.join(temp, 'home');
	const browser = await chromium.launch({ channel: 'msedge', headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 580, height: 850 } });
		await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })); await page.goto('http://localhost/');
		const errors = []; page.on('pageerror', e => errors.push(e.message));
		await page.setContent('<style>body{background:#181818;color:#eee;font:13px sans-serif}nav{width:330px}form[data-thread-find-composer]{position:absolute;bottom:10px}textarea{width:420px;height:100px}</style><nav><div data-sidebar-project-kind="local"><div data-zilpio-thread="one" data-zilpio-host="local"><span data-thread-title>Titolo originale</span></div><div data-zilpio-thread="two" data-zilpio-host="local"><span data-thread-title>Seconda chat</span></div></div></nav><form data-thread-find-composer><textarea>Bozza da conservare</textarea></form>');
		const opened = [];
		await page.exposeFunction('agentBridge', async message => {
			if (message.type === 'navigate-in-new-editor-tab') { opened.push(message); return; }
			let result = { type: 'zilpio-agents-state', requestId: message.requestId };
			try {
				if (message.action === 'suggest') { result.suggestion = await store.suggest(); }
				else {
					if (message.action === 'create') { await store.create({ ...message, home }); }
					if (message.action === 'edit') { await store.edit(message.id, message); }
					if (message.action === 'delete') { await store.remove(message.id); }
					result.agents = (await store.load()).agents.map(a => ({ ...a, available: true, status: 'idle' }));
				}
			} catch (error) { result.error = error.message; }
			await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), result);
		});
		await page.addStyleTag({ path: path.join(root, 'extensions/zilpio-codex/media/agents.css') });
		await page.addScriptTag({ path: path.join(root, 'extensions/zilpio-codex/media/agents-ui.js') });
		await page.evaluate(() => {
			window.zilpioAgents.connect({ postMessage: message => window.agentBridge(message) });
			for (const row of document.querySelectorAll('[data-zilpio-thread]')) {
				row.addEventListener('contextmenu', event => {
					event.preventDefault(); const menu = document.createElement('div'); menu.className = 'native-menu'; menu.setAttribute('role', 'menu');
					for (const item of window.zilpioAgents.menu(row.dataset.zilpioThread, 'local', [{ id: 'native', message: { defaultMessage: 'Rinomina chat' }, onSelect() {} }])) {
						if (item.type === 'separator') { continue; } const button = document.createElement('button'); button.textContent = item.message.defaultMessage; button.setAttribute('role', 'menuitem'); button.onclick = () => { menu.remove(); item.onSelect(); }; menu.append(button);
					} document.body.append(menu);
				});
			}
		});
		await page.locator('[data-zilpio-thread="one"]').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Rinomina chat' }).waitFor();
		await page.getByRole('menuitem', { name: 'Apri in scheda', exact: true }).click();
		await page.waitForFunction(() => !document.querySelector('.native-menu'));
		assert.deepEqual(opened, [{ type: 'navigate-in-new-editor-tab', path: '/local/one' }]);
		const dragged = await page.locator('[data-zilpio-thread="two"]').evaluate(row => {
			const dataTransfer = new DataTransfer();
			row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
			return { draggable: row.draggable, editors: JSON.parse(dataTransfer.getData('CodeEditors') || 'null'), uri: dataTransfer.getData('text/uri-list') };
		});
		assert.deepEqual(dragged, { draggable: true, editors: [{ resource: { $mid: 1, scheme: 'openai-codex', authority: 'route', path: '/local/two' }, options: { override: 'chatgpt.conversationEditor', pinned: true } }], uri: 'openai-codex://route/local/two' });
		await page.locator('[data-zilpio-thread="one"]').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Crea ZilpioAgent' }).click();
		await page.getByRole('button', { name: 'Salva', exact: true }).waitFor();
		await page.waitForFunction(() => !document.querySelector('.zilpio-agent-dialog button[type=submit]').disabled);
		assert.match(await page.getByLabel('Nome', { exact: true }).inputValue(), /^[A-Za-z]+\d*$/);
		await page.getByLabel('Nome', { exact: true }).fill('Elio');
		await page.getByLabel('Colore', { exact: true }).fill('#123abc');
		await page.getByRole('button', { name: 'Salva', exact: true }).click();
		const entry = page.getByRole('button', { name: /^Apri agente Elio:/ }); await entry.waitFor();
		assert.equal(await entry.getAttribute('draggable'), 'true');
		await entry.click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Apri in scheda', exact: true }).click();
		assert.deepEqual(opened.at(-1), { type: 'navigate-in-new-editor-tab', path: '/local/one' });
		assert.equal(await page.locator('[data-zilpio-thread="one"] [data-thread-title]').getAttribute('data-zilpio-label'), 'Elio');
		assert.equal(await page.locator('[data-zilpio-thread="one"] [data-thread-title]').textContent(), 'Titolo originale');
		assert.equal(await page.locator('textarea').inputValue(), 'Bozza da conservare');
		await entry.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Modifica agente' }).click();
		await page.getByLabel('Nome', { exact: true }).fill('Orione'); await page.getByLabel('Colore', { exact: true }).fill('#aabbcc');
		await page.getByRole('button', { name: 'Salva', exact: true }).click();
		await page.getByRole('button', { name: /^Apri agente Orione:/ }).waitFor();
		assert.equal((await store.load()).agents[0].color, '#aabbcc');
		await page.locator('textarea').fill('Controlla con @Ori');
		await page.getByRole('option', { name: '@Orione' }).click();
		assert.equal(await page.locator('textarea').inputValue(), 'Controlla con @Orione ');
		await page.locator('[data-zilpio-thread="two"]').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Crea ZilpioAgent' }).click();
		await page.waitForFunction(() => !document.querySelector('.zilpio-agent-dialog button[type=submit]').disabled);
		await page.getByLabel('Nome', { exact: true }).fill('orione'); await page.getByRole('button', { name: 'Salva', exact: true }).click();
		await page.getByRole('status').filter({ hasText: 'Nome già assegnato' }).waitFor(); await page.getByRole('button', { name: 'Annulla', exact: true }).click();
		await page.getByRole('button', { name: /^Apri agente Orione:/ }).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Elimina agente' }).click();
		await page.waitForFunction(() => !document.querySelector('.zilpio-agent-entry'));
		assert.equal(await page.locator('[data-zilpio-thread="one"]').isVisible(), true);
		assert.equal(await page.locator('[data-zilpio-thread="one"] [data-thread-title]').textContent(), 'Titolo originale');
		await page.locator('textarea').fill('@Or'); assert.equal(await page.getByRole('option').count(), 0);
		assert.deepEqual(errors, []);
		await page.screenshot({ path: path.join(root, '.build/zilpio-agents-ui.png') });
		console.log('PASS: native menu extension, generated names, color, CRUD, title preservation, duplicate feedback, completion and reference revocation.');
	} finally { await browser.close(); await fs.rm(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
