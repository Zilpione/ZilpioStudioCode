/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TrelloStore } = require('./trello.js');

function activate(context) {
	const store = new TrelloStore(process.env.ZILPIO_PROFILES_ROOT || context.globalStorageUri.fsPath);
	const t = message => vscode.l10n.t(message);
	let panel;
	const open = async () => {
		if (panel) { panel.reveal(); return; }
		const folders = vscode.workspace.workspaceFolders || [];
		const folder = folders.length > 1 ? (await vscode.window.showWorkspaceFolderPick({ placeHolder: t('Scegli la cartella da collegare a Trello') })) : folders[0];
		if (!folder) { await vscode.window.showInformationMessage(t('Apri una cartella di lavoro per usare Trello.')); return; }
		if (folder.uri.scheme !== 'file') { throw new Error(t('Trello richiede una cartella di lavoro locale.')); }
		const folderPath = folder.uri.fsPath;
		let board = await store.get(folderPath);
		const current = vscode.window.createWebviewPanel('zilpio.trello', 'Trello', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
		panel = current;
		const nonce = randomUUID(), session = randomUUID();
		const asset = name => current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
		const labels = Object.fromEntries(['Trello', 'Board del progetto', 'Collega Board Trello', 'Impostazioni', 'Cambia Board', 'Rimuovi Collegamento', 'Ricarica', 'Apri nel Browser', 'Annulla', 'Salva', 'Nessuna board collegata a questa cartella.', 'Incolla il link della board da associare al progetto.', 'Caricamento Trello…', 'Impossibile caricare Trello. Usa Ricarica per riprovare.', 'Riavvia ZSCode per attivare la vista Trello integrata.', 'Navigazione limitata alla board del progetto.', 'Link della board Trello'].map(value => [value, t(value)]));
		const initial = JSON.stringify({ folder: folderPath, name: path.basename(folderPath), board, session, labels }).replace(/</g, '\\u003c');
		current.webview.html = `<!doctype html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('trello.css')}"></head><body><header><div><h1>Trello</h1><span id="project"></span></div><nav><button id="reload"></button><button id="external"></button><button id="change"></button></nav></header><p id="notice" role="status"></p><section id="connect"><h2 id="connect-title"></h2><p id="connect-description"></p><form id="board-form"><label id="url-label" for="board-url"></label><input id="board-url" type="url" required placeholder="https://trello.com/b/…" autocomplete="off"><div><button id="save" type="submit"></button><button id="cancel" type="button"></button><button id="remove" type="button"></button></div></form><p id="error" role="alert"></p></section><section id="native-trello"><p id="trello-status" role="status"></p></section><script nonce="${nonce}">window.trelloInitial=${initial};</script><script nonce="${nonce}" src="${asset('trello.js')}"></script></body></html>`;
		const disposables = [];
		disposables.push(current.webview.onDidReceiveMessage(async message => {
			if (!message || typeof message.requestId !== 'string') { return; }
			try {
				if (message.action === 'save') { board = await store.set(folderPath, message.url); }
				else if (message.action === 'remove') { await store.set(folderPath, null); board = undefined; }
				else if (message.action === 'external' && board) { await vscode.env.openExternal(vscode.Uri.parse(board)); }
				else { throw new Error(t('Operazione Trello non valida.')); }
				await current.webview.postMessage({ requestId: message.requestId, board: board || null });
			} catch (error) { await current.webview.postMessage({ requestId: message.requestId, error: error.message }); }
		}));
		disposables.push(current.onDidDispose(() => { panel = undefined; for (const disposable of disposables) { disposable.dispose(); } }));
	};
	context.subscriptions.push(vscode.commands.registerCommand('zilpio.trello.open', () => open().catch(error => vscode.window.showErrorMessage(`Trello: ${error.message}`))), { dispose: () => panel?.dispose() });
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	status.text = '$(project) Trello'; status.command = 'zilpio.trello.open'; status.tooltip = t('Board del progetto');
	const update = () => { if (vscode.workspace.workspaceFolders?.length) { status.show(); } else { status.hide(); } };
	context.subscriptions.push(status, vscode.workspace.onDidChangeWorkspaceFolders(update)); update();
}
module.exports = { activate };
