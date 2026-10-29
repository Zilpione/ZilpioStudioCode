/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { ProfileStore, loadSeedProfiles } = require('./profiles.js');
const { CodexBackend } = require('./backend.js');
const { withAccountRpc } = require('./account-auth.js');

let backend;
let loginWorker;

async function resolveBinary() {
	const configured = vscode.workspace.getConfiguration('zilpio.codex').get('binaryPath');
	if (configured) {
		if (!path.isAbsolute(configured) || path.extname(configured).toLowerCase() === '.cmd' || path.extname(configured).toLowerCase() === '.bat') { throw new Error('Indica il percorso assoluto del binario codex.exe, non del launcher BAT/CMD.'); }
		await fs.access(configured); return configured;
	}
	const candidates = [];
	const bundled = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
	try {
		const dirs = await fs.readdir(bundled, { withFileTypes: true });
		const versions = await Promise.all(dirs.filter(d => d.isDirectory()).map(async d => ({ path: path.join(bundled, d.name, 'codex.exe'), time: (await fs.stat(path.join(bundled, d.name))).mtimeMs })));
		candidates.push(...versions.sort((a, b) => b.time - a.time).map(v => v.path));
	} catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	const triple = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
	const vendor = path.join(process.env.APPDATA || path.join(os.homedir(), '.local', 'lib'), 'npm', 'node_modules', '@openai');
	const target = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
	for (const base of [path.join(vendor, 'codex'), path.join(vendor, `codex-${target}`), path.join(vendor, 'codex', 'node_modules', '@openai', `codex-${target}`)]) {
		for (const folder of ['codex', 'bin']) { candidates.push(path.join(base, 'vendor', triple, folder, process.platform === 'win32' ? 'codex.exe' : 'codex')); }
	}
	for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch (error) { if (error.code !== 'ENOENT') { throw error; } } }
	throw new Error('Codex non trovato. Imposta zilpio.codex.binaryPath con il percorso di codex.exe.');
}

async function activate(context) {
	const root = context.globalStorageUri.fsPath;
	const seeds = loadSeedProfiles();
	const store = new ProfileStore(root, seeds);
	let panel;
	let db;
	let operation = false;
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.RIGHT, 101);
	status.command = 'zilpio.codex.profile';
	context.subscriptions.push(status);
	const post = message => { if (panel) { void panel.webview.postMessage(message); } };
	backend = new CodexBackend(root, resolveBinary, post);
	backend.approve = async (method, params) => {
		if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
			const detail = params.command || params.reason || 'Codex richiede il permesso per modificare file.';
			const choice = await vscode.window.showWarningMessage(String(detail), { modal: true }, 'Consenti');
			return { decision: choice === 'Consenti' ? 'accept' : 'decline' };
		}
		if (method === 'item/permissions/requestApproval') {
			const choice = await vscode.window.showWarningMessage('Codex richiede permessi aggiuntivi.', { modal: true, detail: JSON.stringify(params.permissions, null, 2) }, 'Consenti per questo turno');
			return { permissions: choice ? params.permissions : {}, scope: 'turn' };
		}
		if (method === 'item/tool/requestUserInput') {
			const answers = {};
			for (const question of params.questions) {
				const answer = question.options?.length
					? await vscode.window.showQuickPick(question.options.map(o => ({ label: o.label, description: o.description })), { title: question.question })
					: await vscode.window.showInputBox({ prompt: question.question, password: question.isSecret });
				answers[question.id] = { answers: answer ? [typeof answer === 'string' ? answer : answer.label] : [] };
			}
			return { answers };
		}
		if (method === 'mcpServer/elicitation/request') { return { action: 'decline', content: null }; }
		return undefined;
	};
	const current = () => db?.profiles.find(p => p.id === db.activeProfileId);
	const refresh = async () => {
		db = await store.load();
		const profile = current();
		status.text = `$(openai) Zilpio · ${profile?.name || 'Scegli profilo'} $(chevron-down)`;
		status.tooltip = 'Profili del pannello sperimentale Zilpio; non cambia l’account dell’estensione ufficiale Codex';
		if (vscode.extensions.getExtension('openai.chatgpt')) { status.hide(); } else { status.show(); }
		post({ type: 'profile', id: profile?.id, name: profile?.name || 'Scegli profilo' });
	};
	const run = async fn => {
		if (operation) { throw new Error('Attendi il completamento dell’operazione in corso.'); }
		operation = true;
		post({ type: 'operation', busy: true });
		try { return await fn(); }
		finally { operation = false; post({ type: 'operation', busy: false }); }
	};
	const report = error => {
		const message = error instanceof Error ? error.message : String(error);
		post({ type: 'error', message });
		void vscode.window.showErrorMessage(`Zilpio Codex: ${message}`);
	};
	const select = async profile => {
		backend.assertIdle();
		// Authenticate before committing the database selection. Missing accounts
		// can be selected for login, but cannot send a turn until connected.
		let signedIn = false;
		try {
			await backend.switchProfile(profile);
			signedIn = true;
		} catch (error) {
			if (!String(error.message).includes('Collega un account')) { throw error; }
		}
		const prior = current();
		try { await store.select(profile.id); }
		catch (error) { if (signedIn && prior) { await backend.switchProfile(prior); } throw error; }
		if (!signedIn) { backend.authenticated = false; }
		await refresh();
		if (!signedIn) { void vscode.window.showInformationMessage('Ambiente selezionato. Usa “Collega account” per configurarlo.'); }
	};
	const newEnvironment = async () => {
		backend.assertIdle();
		const name = await vscode.window.showInputBox({ title: 'Nuovo account Codex', prompt: 'Nome del profilo, ad esempio Personale oppure Lavoro', validateInput: value => /^[\p{L}\p{N} _-]{1,60}$/u.test(value.trim()) ? undefined : 'Usa lettere, numeri, spazi, _ o -.' });
		if (!name) { return; }
		const profile = await store.create(name);
		await store.select(profile.id);
		backend.authenticated = false;
		await refresh();
		void vscode.window.showInformationMessage(`Ambiente ${profile.name} creato. Collega il suo account quando vuoi.`);
	};
	const login = async () => {
		backend.assertIdle();
		await refresh();
		const profile = current();
		if (!profile) { throw new Error('Crea o seleziona un profilo prima di collegare l’account.'); }
		const choice = await vscode.window.showQuickPick(['Account ChatGPT', 'Chiave API OpenAI'], { title: `Collega ${profile.name}` });
		if (!choice) { return; }
		await fs.mkdir(profile.home, { recursive: true });
		loginWorker?.dispose();
		const connected = await withAccountRpc(await resolveBinary(), profile, async worker => {
			loginWorker = worker;
			try {
				await worker.initialize();
				if (choice === 'Chiave API OpenAI') {
					const key = await vscode.window.showInputBox({ prompt: 'Chiave API OpenAI', password: true, ignoreFocusOut: true });
					if (!key) { return false; }
					await worker.request('account/login/start', { type: 'apiKey', apiKey: key });
				} else {
					const completion = new Promise((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error('Accesso scaduto. Riprova.')), 300000);
						worker.on('notification', (method, params) => {
							if (method !== 'account/login/completed') { return; }
							clearTimeout(timer);
							if (params.success) { resolve(); } else { reject(new Error('Accesso non completato.')); }
						});
						worker.on('closed', () => { clearTimeout(timer); reject(new Error('Accesso interrotto.')); });
					});
					// Install rejection handling before launching the browser.
					completion.catch(() => {});
					const result = await worker.request('account/login/start', { type: 'chatgpt' });
					const url = new URL(result.authUrl);
					if (url.protocol !== 'https:' || !(url.hostname === 'auth.openai.com' || url.hostname === 'chatgpt.com')) { throw new Error('URL di accesso Codex non valido.'); }
					await vscode.env.openExternal(vscode.Uri.parse(url.href));
					await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Accesso a ${profile.name}`, cancellable: true }, async (_, token) => {
						const subscription = token.onCancellationRequested(() => worker.dispose());
						try { await completion; } finally { subscription.dispose(); }
					});
				}
				return true;
			} finally { if (loginWorker === worker) { loginWorker = undefined; } }
		});
		if (connected) {
			await backend.switchProfile(profile);
			void vscode.window.showInformationMessage(`Account collegato a ${profile.name}.`);
		}
	};
	const editProfiles = async () => { await store.load(); await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(store.file))); };
	const picker = async () => {
		backend.assertIdle();
		await refresh();
		const choice = await vscode.window.showQuickPick([
			...db.profiles.map(profile => ({ label: `${profile.id === db.activeProfileId ? '$(check) ' : ''}${profile.name}`, description: profile.home, profile })),
			{ label: '$(add) Nuovo ambiente…', action: 'new' },
			{ label: '$(sign-in) Collega account…', action: 'login' },
			{ label: '$(edit) Modifica JSON profili', action: 'edit' },
			{ label: '$(comment-discussion) Apri chat Codex', action: 'chat' }
		], { title: 'Profilo Codex', placeHolder: 'Cambia account mantenendo la conversazione' });
		if (!choice) { return; }
		if (choice.profile) { await select(choice.profile); }
		else if (choice.action === 'new') { await newEnvironment(); }
		else if (choice.action === 'login') { await login(); }
		else if (choice.action === 'edit') { await editProfiles(); }
		else { await open(); }
	};
	const open = async () => {
		if (panel) { panel.reveal(); return; }
		panel = vscode.window.createWebviewPanel('zilpio.codex.chat', 'Codex · Zilpio', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
		const nonce = randomBytes(24).toString('base64');
		const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.js'));
		const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.css'));
		panel.webview.html = `<!doctype html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><header><strong>Codex</strong><button id="new">Nuova chat</button><button id="history">Storico</button></header><main id="messages" aria-live="polite"></main><footer><div class="profile"><button id="profile">Scegli profilo ▾</button><button id="login">Collega account</button></div><form id="composer"><textarea id="prompt" rows="3" placeholder="Scrivi a Codex…" aria-label="Messaggio a Codex"></textarea><div><span id="state"></span><button id="stop" type="button" hidden>Interrompi</button><button id="send" type="submit">Invia</button></div></form></footer><script nonce="${nonce}" src="${script}"></script></body></html>`;
		const local = [];
		local.push(panel.onDidDispose(() => { panel = undefined; for (const subscription of local) { subscription.dispose(); } }));
		local.push(panel.webview.onDidReceiveMessage(message => {
			if (!message || typeof message.type !== 'string') { return; }
			if (message.type === 'stop') { void backend.interrupt().catch(report); return; }
			void run(async () => {
				if (message.type === 'ready') {
					await refresh();
					if (backend.threadId && backend.rpc && !backend.rpc.closed) {
						const snapshot = await backend.rpc.request('thread/read', { threadId: backend.threadId, includeTurns: true });
						post({ type: 'restore', thread: snapshot.thread, profiles: backend.meta.chats.find(c => c.id === backend.threadId)?.turnProfiles || [] });
					}
					post({ type: 'busy', busy: backend.busy });
				}
				else if (message.type === 'profile') { await picker(); }
				else if (message.type === 'login') { await login(); }
				else if (message.type === 'new') { backend.newChat(); post({ type: 'clear' }); }
				else if (message.type === 'history') {
					backend.assertIdle();
					const chats = await backend.history();
					const chat = await vscode.window.showQuickPick(chats.map(c => ({ label: c.title, description: new Date(c.createdAt).toLocaleString(), id: c.id })), { title: 'Storico unico Codex' });
					if (chat) { post({ type: 'restore', ...(await backend.openThread(chat.id)) }); }
				} else if (message.type === 'send') {
					if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 100000) { throw new Error('Messaggio vuoto o troppo lungo.'); }
					await refresh();
					const profile = current();
					if (!profile) { throw new Error('Seleziona prima un profilo Codex.'); }
					const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file');
					if (!folder) { throw new Error('Apri una cartella locale del progetto prima di inviare messaggi.'); }
					await backend.send(message.text.trim(), folder.uri.fsPath, profile);
				}
			}).catch(report);
		}));
	};
	for (const [id, fn] of [['open', open], ['profile', picker], ['newEnvironment', newEnvironment], ['editProfiles', editProfiles], ['login', login]]) {
		context.subscriptions.push(vscode.commands.registerCommand(`zilpio.codex.${id}`, () => run(fn).catch(report)));
	}
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => { if (document.uri.fsPath === store.file) { void refresh().catch(report); } }));
	require('./trello-page.js').activate(context);
	if (vscode.extensions.getExtension('openai.chatgpt')) { require('./workspace-page.js').activate(context); }
	try { await refresh(); if (!vscode.extensions.getExtension('openai.chatgpt')) { await open(); } } catch (error) { report(error); }
}

async function deactivate() { loginWorker?.dispose(); await backend?.dispose(); }
module.exports = { activate, deactivate };
