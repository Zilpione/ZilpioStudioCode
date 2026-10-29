const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async () => {
	const report = path.resolve(__dirname, '../../.build/notifier-host-smoke.json');
	try {
		const extension = vscode.extensions.getExtension('zilpio.codex-notifier-telegram');
		assert.ok(extension, 'Notifier must be discovered');
		assert.ok(extension.extensionPath.replaceAll('\\', '/').includes('/resources/app/extensions/'), 'Notifier must be bundled with the editor');
		assert.equal(extension.packageJSON.version, '0.0.7');
		await extension.activate();
		const commands = await vscode.commands.getCommands();
		for (const command of extension.packageJSON.contributes.commands) { assert.ok(commands.includes(command.command), command.command); }
		await vscode.commands.executeCommand('codexNotifierTelegram.openSettingsPanel');
		await fs.writeFile(report, JSON.stringify({ passed: true, checks: ['bundled extension discovery', 'activation', 'six commands', 'settings panel opens'] }));
	} catch (error) { await fs.writeFile(report, JSON.stringify({ passed: false, error: error.message })); throw error; }
};
