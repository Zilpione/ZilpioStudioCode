const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async () => {
	const report = path.resolve(__dirname, '../../.build/debug-host-smoke.json');
	let timer, tracker;
	try {
		const extension = vscode.extensions.getExtension('ms-dotnettools.csharp');
		if (!extension) { throw new Error('C# extension not discovered'); }
		await extension.activate();
		const folder = vscode.workspace.workspaceFolders[0];
		const configuration = vscode.workspace.getConfiguration('launch', folder.uri).get('configurations')[0];
		let stopped;
		const ready = new Promise((resolve, reject) => {
			stopped = resolve;
			timer = setTimeout(() => reject(new Error('Debugger did not stop at entry within 60 seconds')), 60000);
		});
		ready.catch(() => {});
		tracker = vscode.debug.registerDebugAdapterTrackerFactory('coreclr', {
			createDebugAdapterTracker: () => ({ onDidSendMessage: message => {
				if (message.type === 'event' && message.event === 'stopped') { stopped(); }
			} })
		});
		const started = await vscode.debug.startDebugging(folder, { ...configuration, stopAtEntry: true });
		if (!started) { throw new Error('Debug start rejected'); }
		await ready;
		await vscode.debug.stopDebugging();
		await fs.writeFile(report, JSON.stringify({ passed: true, checks: ['C# activation', 'project build', 'coreclr launch', 'stopped at entry'] }));
	} catch (error) {
		await fs.writeFile(report, JSON.stringify({ passed: false, error: error.message }));
		throw error;
	} finally { clearTimeout(timer); tracker?.dispose(); }
};
