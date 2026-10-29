const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async () => {
	const report = path.resolve(__dirname, '../../../.build/extension-host-smoke.json');
	try {
		const extension = vscode.extensions.getExtension('zilpio.zilpio-codex');
		assert.ok(extension, 'Bundled extension must be discovered');
		await extension.activate();
		const commands = await vscode.commands.getCommands();
		for (const id of ['open', 'profile', 'newEnvironment', 'editProfiles', 'login']) { assert.ok(commands.includes(`zilpio.codex.${id}`), `${id} command must be registered`); }
		const db = JSON.parse(await fs.readFile(path.join(extension.extensionPath, 'profiles.json'), 'utf8'));
		assert.equal(db.version, 1);
		await vscode.commands.executeCommand('zilpio.codex.open');
		await fs.writeFile(report, JSON.stringify({ passed: true, checks: ['activation', 'five native commands', 'profile seed', 'chat webview opens'] }, null, 2));
	} catch (error) { await fs.writeFile(report, JSON.stringify({ passed: false, error: error.message })); throw error; }
};
