const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
	const report = path.join(__dirname, '../../.build/workspaces-host-report.json');
	try {
		await vscode.extensions.getExtension('zilpio.zilpio-codex').activate();
		await vscode.commands.executeCommand('zilpio.workspaces.open');
		await vscode.commands.executeCommand('chatgpt.openSidebar');
		const state = await vscode.commands.executeCommand('zilpio.workspaces.backend', { action: 'list' });
		assert.equal(state.version, 1);
		assert.equal(state.busy, false);
		assert.ok(state.environments.some(e => e.id === 'el'));
		assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Workspace')));
		await vscode.commands.executeCommand('zilpio.workspaces.backend', { action: 'save', kind: 'usageCards', card: { id: 'host', name: 'Host Test', accountId: 'missing', color: '#7c8aff' } });
		await vscode.commands.executeCommand('zilpio.workspaces.backend', { action: 'delete', kind: 'usageCards', id: 'host' });
		const after = await vscode.commands.executeCommand('zilpio.workspaces.backend', { action: 'list' });
		assert.equal(after.usageCards.length, 0);
		await fs.writeFile(report, JSON.stringify({ passed: true, checks: ['real extension activation', 'Workspace editor', 'official backend bridge', 'environment list', 'card persistence and delete'] }));
	} catch (error) { await fs.writeFile(report, JSON.stringify({ passed: false, error: error.stack })); throw error; }
};
