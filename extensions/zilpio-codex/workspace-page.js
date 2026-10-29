/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { randomUUID } = require('node:crypto');
const vscode = require('vscode');

function activate(context) {
	let panel, opening = false, disposed = false;
	const open = async () => {
		if (panel) { panel.reveal(vscode.ViewColumn.One); return; }
		panel = vscode.window.createWebviewPanel('zilpio.workspaces', 'Workspace', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
		const current = panel;
		const disposables = [];
		const nonce = randomUUID();
		const asset = name => current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
		current.webview.html = `<!doctype html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('workspaces.css')}"></head><body><main><header><div><p class="eyebrow">ZILPIO STUDIO CODE</p><h1>Workspace</h1><p class="subtitle">I tuoi progetti, pronti per lavorare.</p></div></header><p id="notice" role="status" hidden></p><section aria-labelledby="projects-title"><div class="section-heading"><h2 id="projects-title">I tuoi workspace</h2><button id="add-workspace">＋ Aggiungi Workspace</button></div><div id="workspaces" class="grid"></div></section><section class="usage-section" aria-labelledby="usage-title"><div class="section-heading"><div><h2 id="usage-title">Consumo token</h2><p class="subtitle">Gli account che vuoi tenere d’occhio.</p></div><div class="actions"><button id="refresh">Aggiorna</button><button id="add-usage">＋ Aggiungi Account</button></div></div><div id="usageCards" class="grid"></div></section></main><dialog id="edit-dialog"><form id="edit-form"><h2 id="form-title"></h2><label>Nome<input id="name" maxlength="100" required></label><div id="folder-field"><label>Cartella<div class="folder-input"><input id="folder" readonly><button id="browse" type="button">Sfoglia…</button></div></label></div><label>Account<select id="account" required></select></label><label id="environment-field">Environment<select id="environment"></select></label><label class="color-field">Colore del bordo<input id="color" type="color" value="#7c8aff"></label><p id="form-error" role="alert"></p><div class="dialog-actions"><button id="cancel" type="button">Annulla</button><button type="submit" class="primary">Salva</button></div></form></dialog><script nonce="${nonce}" src="${asset('workspaces.js')}"></script></body></html>`;
		const backend = async message => {
			await vscode.extensions.getExtension('openai.chatgpt')?.activate();
			const commands = await vscode.commands.getCommands();
			if (!commands.includes('zilpio.workspaces.backend')) { await vscode.commands.executeCommand('chatgpt.openSidebar'); }
			return vscode.commands.executeCommand('zilpio.workspaces.backend', message);
		};
		disposables.push(current.webview.onDidReceiveMessage(async message => {
			if (!message || typeof message.requestId !== 'string') { return; }
			try {
				let result;
				if (message.action === 'trello') {
					await vscode.commands.executeCommand('zilpio.trello.open');
				} else if (message.action === 'browse') {
					const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Cartella del Workspace' });
					result = folders?.[0]?.fsPath;
				} else if (message.action === 'delete') {
					const answer = await vscode.window.showWarningMessage('Eliminare questa card?', { modal: true, detail: 'La cartella e l’account saranno conservati.' }, 'Elimina');
					if (answer === 'Elimina') { result = await backend(message); }
				} else { result = await backend(message); }
				await current.webview.postMessage({ requestId: message.requestId, result });
			} catch (error) { await current.webview.postMessage({ requestId: message.requestId, error: error.message }); }
		}));
		disposables.push(current.onDidDispose(() => { panel = undefined; for (const disposable of disposables) { disposable.dispose(); } queueMicrotask(openIfEmpty); }));
	};
	const openIfEmpty = () => {
		if (disposed || opening || panel || vscode.window.tabGroups.all.some(group => group.tabs.length)) { return; }
		opening = true;
		void open().catch(error => vscode.window.showErrorMessage(`Workspace: ${error.message}`)).finally(() => { opening = false; });
	};
	context.subscriptions.push(vscode.commands.registerCommand('zilpio.workspaces.open', open), vscode.window.tabGroups.onDidChangeTabs(openIfEmpty), { dispose: () => { disposed = true; panel?.dispose(); } });
	openIfEmpty();
}
module.exports = { activate };
