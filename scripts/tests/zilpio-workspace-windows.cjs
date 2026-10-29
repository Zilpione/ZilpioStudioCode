/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron } = require(require.resolve('playwright-core', { paths: [require.resolve('@playwright/browser-chromium')] }));
const root = path.resolve(__dirname, '../..');

(async () => {
	const run = await fs.mkdtemp(path.join(root, '.build/workspace-windows-'));
	const folder = path.join(run, 'Shared Project');
	await fs.mkdir(folder);
	await fs.mkdir(path.join(folder, '.vscode'));
	await fs.writeFile(path.join(folder, '.vscode/settings.json'), '{"window.title":"Shared project test"}');
	await fs.writeFile(path.join(folder, 'shared.txt'), 'Shared file\n');
	await fs.mkdir(path.join(run, 'user/User'), { recursive: true });
	await fs.writeFile(path.join(run, 'user/User/settings.json'), JSON.stringify({ 'window.openFoldersInNewWindow': 'on', 'window.openFilesInNewWindow': 'off', 'window.dialogStyle': 'custom', 'files.hotExit': 'off', 'git.openRepositoryInParentFolders': 'never' }));
	const executablePath = path.join(root, '.build/clean-host/ZSCode.Editor.exe');
	const common = ['--user-data-dir', path.join(run, 'user'), '--extensions-dir', path.join(run, 'extensions'), '--disable-extensions', '--disable-extension', 'zilpio.zilpio-codex', '--disable-extension', 'openai.chatgpt', '--disable-extension', 'zilpio.zilpio-codex-notifier', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates'];
	const env = { ...process.env, ZILPIO_PROFILES_ROOT: path.join(run, 'registry'), CODEX_HOME: path.join(run, 'codex') };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ZILPIO_LAUNCHER;
	let app;
	try {
		app = await _electron.launch({ executablePath, args: [...common, '--new-window', folder], env, timeout: 30000 });
		const first = await app.firstWindow();
		await first.locator('.monaco-workbench').waitFor({ timeout: 30000 });
		async function open(target, expected, mode = '--new-window') {
			const child = spawn(executablePath, [...common, ...(mode ? [mode] : []), target], { env, windowsHide: true, stdio: 'ignore' });
			await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Launcher exited ${code}`))); });
			const deadline = Date.now() + 15000;
			while (app.windows().length < expected && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 200)); }
			await new Promise(resolve => setTimeout(resolve, 400));
			assert.equal(app.windows().length, expected, `Opening ${path.basename(target)} must create window ${expected}`);
			const page = app.windows().at(-1);
			await page.locator('.monaco-workbench').waitFor({ timeout: 30000 });
			return page;
		}
		await open(path.join(folder, 'shared.txt'), 1, null);
		const second = await open(folder, 2);
		await open(folder, 2, '--reuse-window');
		const workspaceDirectory = path.join(run, 'user/WindowWorkspaces');
		const duplicateId = (await fs.readdir(workspaceDirectory))[0];
		const duplicateFile = path.join(workspaceDirectory, duplicateId, 'workspace.code-workspace');
		const folderWorkspace = JSON.parse(await fs.readFile(duplicateFile, 'utf8'));
		assert.equal(folderWorkspace.settings['window.title'], 'Shared project test', 'Workspace settings from .vscode must apply in the second window');
		console.log('Two windows opened on the same folder.');
		async function edit(page, text) {
			await (await app.browserWindow(page)).evaluate(window => window.focus());
			await page.bringToFront();
			await page.getByText('shared.txt', { exact: true }).first().dblclick();
			await page.locator('.monaco-editor .view-lines').first().waitFor();
			await page.locator('.monaco-editor .view-lines').first().click();
			await page.keyboard.press('Control+End');
			await page.keyboard.type(text);
		}
		await edit(first, 'First window unsaved');
		await edit(second, 'Second window saved');
		await second.locator('.tabs-container .tab.dirty').first().waitFor();
		await (await app.browserWindow(second)).evaluate(window => window.close());
		await second.getByRole('button', { name: 'Cancel', exact: true }).click();
		assert.equal(app.windows().length, 2);
		assert.equal(JSON.parse(await fs.readFile(duplicateFile, 'utf8')).folders.length, 1, 'Canceling close must preserve the window workspace');
		await second.keyboard.press('Control+s');
		await new Promise(resolve => setTimeout(resolve, 800));
		assert.equal(await fs.readFile(path.join(folder, 'shared.txt'), 'utf8'), 'Shared file\nSecond window saved');
		assert.ok(await first.locator('.view-lines').first().innerText().then(text => text.replace(/\u00a0/g, ' ').includes('First window unsaved')), 'The first window must keep its unsaved buffer');
		await (await app.browserWindow(second)).evaluate(window => window.close());
		const closed = Date.now() + 4000;
		while (app.windows().length !== 1 && Date.now() < closed) { await new Promise(resolve => setTimeout(resolve, 100)); }
		assert.equal(app.windows().length, 1);
		assert.ok(await first.locator('.view-lines').first().innerText().then(text => text.replace(/\u00a0/g, ' ').includes('First window unsaved')));
		const other = path.join(run, 'Other Project');
		await fs.mkdir(other);
		const workspace = path.join(run, 'Shared.code-workspace');
		await fs.writeFile(workspace, '{ // workspace with relative paths and settings\n "folders": [{"path":"Shared Project","name":"Main"},{"path":"Other Project"}], "settings":{"editor.tabSize":7}, "tasks":{"version":"2.0.0","tasks":[]},\n}');
		await open(workspace, 2);
		await open(workspace, 3);
		const copies = await Promise.all((await fs.readdir(workspaceDirectory)).map(id => fs.readFile(path.join(workspaceDirectory, id, 'workspace.code-workspace'), 'utf8').then(JSON.parse)));
		const multi = copies.find(copy => copy.folders.length === 2);
		assert.ok(multi, 'The second saved workspace must have independent state');
		assert.equal(multi.settings['editor.tabSize'], 7);
		assert.deepEqual(multi.tasks, { version: '2.0.0', tasks: [] });
		assert.deepEqual(multi.folders.map(f => path.resolve(f.path)), [folder, other]);
		console.log('PASS: two windows share files, retain independent unsaved buffers, and duplicate multi-root workspaces with settings and tasks.');
	} catch (error) {
		for (const [index, page] of (app?.windows() ?? []).entries()) {
			await page.screenshot({ path: path.join(root, `.build/workspace-window-failure-${index}.png`) }).catch(() => {});
		}
		throw error;
	} finally {
		await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
		await app?.close().catch(() => {});
		await fs.rm(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
