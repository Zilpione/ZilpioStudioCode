/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const extensionRoot = fs.existsSync(path.join(__dirname, 'extensions/zilpio-codex')) ? path.join(__dirname, 'extensions/zilpio-codex') : path.join(__dirname, '../extensions/zilpio-codex');
const { boardUrl, navigation } = require(path.join(extensionRoot, 'trello.js'));

/** Read only our extension's placeholder, and keep the native view inside its visible editor. */
async function findHost(window) {
	for (const wrapper of window.webContents.mainFrame.framesInSubtree) {
		let url;
		try { url = new URL(wrapper.url); } catch { continue; }
		if (url.protocol !== 'vscode-webview:' || url.searchParams.get('extensionId') !== 'zilpio.zilpio-codex') { continue; }
		for (const frame of wrapper.frames) {
			let state;
			try {
				state = await frame.executeJavaScript(`(() => { const e = document.querySelector('[data-zilpio-trello]'); if (!e) return null; const r = e.getBoundingClientRect(); return { session: e.dataset.zilpioTrello, board: e.dataset.board, revision: e.dataset.revision, loading: e.dataset.loading, failed: e.dataset.failed, x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
			} catch { continue; }
			if (!state) { continue; }
			const outer = await window.webContents.executeJavaScript(`(() => {
				const e = [...document.querySelectorAll('iframe.webview')].find(e => e.name === ${JSON.stringify(url.searchParams.get('id'))});
				if (!e) return null;
				const r = e.getBoundingClientRect();
				const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
				const visible = e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && right > left && bottom > top && document.elementFromPoint((left + right) / 2, (top + bottom) / 2) === e;
				const overlay = [...document.querySelectorAll('.quick-input-widget, .monaco-dialog-box, .context-view')].some(e => e.checkVisibility() && e.getBoundingClientRect().height > 0);
				return visible && !overlay ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
			})()`);
			return { ...state, frame, outer };
		}
	}
	return null;
}

function install(electron = require('electron')) {
	const { app, WebContentsView, BrowserWindow, ipcMain, shell, session } = electron;
	const records = new Map();
	const partition = 'persist:zilpio-trello';
	let trelloSession;
	// Keep only route names: OAuth codes, query strings, fragments and cookies
	// must never enter the diagnostic log.
	function trace(event, value) {
		try {
			const url = new URL(value);
			const route = url.pathname.split('/').map(part => /^(?:|auth|atlassian|callback|login|logout|signup|authenticate|authentication|authorization|authorize|OAuthAuthorizeToken|1|b|c|u|w|boards|home|session|sessions|finish|continue|outboundAuth|social|google|microsoft|apple|oauth2|oauth|v2|v3|signin|challenge|identifier|selectaccount|AccountChooser|CheckCookie|SetSID)$/.test(part) ? part : '_').join('/');
			const file = path.join(app.getPath('userData'), 'logs', 'trello-navigation.log');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			if (fs.existsSync(file) && fs.statSync(file).size > 65536) { fs.writeFileSync(file, ''); }
			fs.appendFileSync(file, `${new Date().toISOString()} ${event} ${url.origin}${route}\n`);
		} catch { /* Diagnostics must not interrupt navigation. */ }
	}
	const preferences = () => ({ partition, preload: path.join(__dirname, 'trello-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });
	const external = url => { if (navigation(url, 'https://trello.com/b/00000000') === 'external') { void shell.openExternal(url).catch(error => console.error('Trello external link:', error.message)); } };
	async function refreshCards(record) {
		if (record.refreshing) { return record.refreshing; }
		const short = new URL(record.board).pathname.split('/')[2];
		record.refreshing = record.contents.session.fetch(`https://trello.com/1/boards/${short}?fields=id&cards=all&card_fields=shortLink,idBoard`, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(response => response.ok ? response.json() : null).then(board => {
			if (!board || !/^[a-f0-9]{24}$/.test(board.id) || !Array.isArray(board.cards)) { return; }
			record.boardId = board.id;
			record.cards = new Set(board.cards.filter(card => card.idBoard === board.id && /^[a-zA-Z0-9]{8}$/.test(card.shortLink)).flatMap(card => [card.shortLink, ...(/^[a-f0-9]{24}$/.test(card.id) ? [card.id] : [])]));
		}).catch(() => {}).finally(() => { record.refreshing = undefined; });
		return record.refreshing;
	}
	async function verifyCard(record, id) {
		try {
			if (!record.boardId) { await refreshCards(record); }
			if (!record.boardId || record.contents.isDestroyed()) { return false; }
			const response = await record.contents.session.fetch(`https://trello.com/1/cards/${id}?fields=idBoard,shortLink`, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10000) });
			if (!response.ok) { return false; }
			const card = await response.json();
			if (card.idBoard !== record.boardId || !/^[a-zA-Z0-9]{8}$/.test(card.shortLink) || !/^[a-f0-9]{24}$/.test(card.id)) { return false; }
			record.cards.add(card.shortLink); record.cards.add(card.id);
			return true;
		} catch { return false; }
	}
	function admitAuthReturn(record, target, sourceOrigin) {
		// Atlassian may return through an HTTP redirect, location.replace or
		// a link. Trust the source of that handoff, not its transport mechanism.
		if (!record.authenticating || !['https://id.atlassian.com', 'https://auth.atlassian.com'].includes(sourceOrigin)) { return; }
		if (target.origin === 'https://trello.com' && !target.username && !target.password && target.pathname !== '/' && !/^\/(?:b|c|w|u|boards|home)(?:\/|$)/.test(target.pathname) && !/\/boards\/?$/.test(target.pathname)) {
			record.authReturn = target.origin + target.pathname;
			trace('auth-callback', target.href);
		}
	}
	function route(record, url, openExternal = false) {
		let target;
		try { target = new URL(url); } catch { return false; }
		if (target.protocol !== 'https:' || target.username || target.password || target.port) { return false; }
		let sourceOrigin;
		try { sourceOrigin = new URL(record.contents.getURL()).origin; } catch { /* Initial popup documents can have an empty URL. */ }
		admitAuthReturn(record, target, sourceOrigin);
		const card = /^https:\/\/trello\.com\/c\/([a-zA-Z0-9]{8})(?:\/|$)/.exec(url);
		if (card) {
			// Only same-card SPA updates can reuse the current admission. Every
			// opening from the board (including a cached link) checks live membership.
			if (!openExternal && record.admittedCard === card[1] && record.contents.getURL().startsWith(`https://trello.com/c/${card[1]}`)) { return true; }
			if (!record.cardPending) {
				record.cardPending = true;
				void verifyCard(record, card[1]).then(allowed => {
					if (allowed && !record.contents.isDestroyed()) { record.admittedCard = card[1]; void record.contents.loadURL(url).catch(() => {}); }
				}).finally(() => { record.cardPending = false; });
			}
			return false;
		}
		const attachment = /^https:\/\/trello\.com\/1\/cards\/([a-f0-9]{24})\/attachments\/[a-f0-9]{24}\/download(?:\/|$)/.exec(url);
		if (attachment) {
			if (openExternal) { void verifyCard(record, attachment[1]).then(allowed => { if (allowed && !record.contents.isDestroyed()) { record.contents.downloadURL(url); } }); }
			return false;
		}
		const action = navigation(url, record.board, record.cards);
		if (action === 'auth') { record.authenticating = true; record.authOrigin = target.origin; return true; }
		if (record.authenticating && record.authReturn === target.origin + target.pathname) { record.authOrigin = target.origin; return true; }
		if (action === 'allow') { record.admittedCard = undefined; record.authenticating = false; record.authReturn = undefined; record.authOrigin = undefined; return true; }
		if (action === 'download' && openExternal) { record.contents.downloadURL(url); }
		if (action === 'external' && openExternal) { external(url); }
		if (record.authenticating && /^https:\/\/trello\.com\//.test(url) && action === 'block') {
			trace('blocked-auth-return', url);
			record.authenticating = false;
			setImmediate(() => { if (!record.contents.isDestroyed()) { void record.contents.loadURL(record.board).catch(() => {}); } });
		}
		return false;
	}
	ipcMain.on('zilpio:trello:navigate', (event, url, openExternal) => {
		const record = records.get(event.sender.id);
		event.returnValue = !!record && event.senderFrame === event.sender.mainFrame && typeof url === 'string' && route(record, url, openExternal === true);
	});
	function guard(contents, record, parent) {
		records.set(contents.id, record);
		contents.on('destroyed', () => records.delete(contents.id));
		// VS Code installs a deny-all workbench navigation listener on every new
		// webContents. Replace it only on these dedicated sandboxed Trello contents.
		contents.removeAllListeners('will-navigate');
		const check = (event, url, redirect = false) => {
			const target = url || event.url;
			if (redirect) { admitAuthReturn(record, new URL(target), record.authOrigin); }
			const allowed = route(record, target);
			trace(allowed ? 'allow' : 'block', target);
			if (!allowed) { event.preventDefault(); }
		};
		contents.on('will-navigate', check);
		contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (isMainFrame !== false) { check(event, url, true); } });
		contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
			if (isMainFrame && !route(record, url)) {
				record.view?.setVisible(false);
				void contents.loadURL(record.board).catch(() => {});
			}
		});
		contents.setWindowOpenHandler(({ url }) => {
			const action = navigation(url, record.board, record.cards);
			trace(`popup-${action}`, url);
			if (action === 'auth' && !record.popup) {
				return { action: 'allow', createWindow: options => {
					const popup = new BrowserWindow({ ...options, parent, width: 600, height: 760, autoHideMenuBar: true, webPreferences: preferences() });
					record.popup = popup;
					const popupRecord = { ...record, contents: popup.webContents, view: undefined, authenticating: true, authOrigin: new URL(url).origin, authReturn: undefined };
					guard(popup.webContents, popupRecord, popup);
					popup.on('closed', () => { record.popup = undefined; if (!record.contents.isDestroyed()) { void record.contents.loadURL(record.board).catch(() => {}); } });
					return popup.webContents;
				} };
			}
			if (action === 'allow' && !/^https:\/\/trello\.com\/c\//.test(url)) { void contents.loadURL(url).catch(() => {}); }
			else { route(record, url, true); }
			return { action: 'deny' };
		});
		contents.on('dom-ready', () => { trace('document-ready', contents.getURL()); void refreshCards(record); });
		// Preserve workbench shortcuts while focus is inside the native page.
		contents.on('before-input-event', (event, input) => {
			if (record.view && (input.control || input.meta) && ['p', 'w', 'tab', '`'].includes(input.key.toLowerCase())) {
				event.preventDefault(); record.view?.setVisible(false); parent.webContents.focus();
				parent.webContents.sendInputEvent({ type: input.type, keyCode: input.key, modifiers: [input.control ? 'control' : 'meta', ...(input.shift ? ['shift'] : [])] });
			}
		});
	}
	app.on('browser-window-created', (_event, window) => {
		if (!window.webContents || !window.contentView) { return; }
		let record, busy = false, disposed = false;
		const disposeView = () => {
			if (!record) { return; }
			record.popup?.destroy();
			if (!window.isDestroyed()) { window.contentView.removeChildView(record.view); }
			if (!record.contents.isDestroyed()) { record.contents.close(); }
			record = undefined;
		};
		const status = (host, message) => host.frame.executeJavaScript(`(() => { const e = document.getElementById('native-trello'); if(e) e.dataset.nativeReady = 'true'; const s = document.getElementById('trello-status'); if(s) s.textContent = ${JSON.stringify(message)}; })()`).catch(() => {});
		const sync = async () => {
			if (busy || disposed || window.isDestroyed()) { return; }
			busy = true;
			try {
				if (window.isMinimized()) { record?.view.setVisible(false); return; }
				const host = await findHost(window);
				if (disposed) { return; }
				if (!host) { disposeView(); return; }
				if (!host.outer || !host.board || host.width < 1 || host.height < 1) { record?.view.setVisible(false); return; }
				const board = boardUrl(host.board);
				if (record && (record.board !== board || record.session !== host.session)) { disposeView(); }
				if (!record) {
					if (!trelloSession) {
						trelloSession = session.fromPartition(partition);
						trelloSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
						trelloSession.setPermissionCheckHandler(() => false);
					}
					const view = new WebContentsView({ webPreferences: preferences() }); view.setVisible(false);
					record = { board, session: host.session, revision: host.revision, view, contents: view.webContents, cards: new Set(), ready: false };
					const own = record;
					guard(own.contents, own, window);
					own.contents.on('dom-ready', () => { own.ready = true; void status(host, ''); });
					own.contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { own.ready = false; own.view.setVisible(false); void status(host, host.failed); console.error('Trello load:', code, description); } });
					window.contentView.addChildView(view);
					void status(host, host.loading);
					void own.contents.loadURL(board).catch(() => {});
				}
				if (record.revision !== host.revision) {
					record.revision = host.revision; record.ready = false;
					void record.contents.loadURL(record.board).catch(() => {});
				}
				const zoom = window.webContents.getZoomFactor();
				const x = Math.max(host.outer.x, host.outer.x + host.x), y = Math.max(host.outer.y, host.outer.y + host.y);
				const right = Math.min(host.outer.x + host.outer.width, x + host.width), bottom = Math.min(host.outer.y + host.outer.height, y + host.height);
				record.view.setBounds({ x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.max(0, Math.round((right - x) * zoom)), height: Math.max(0, Math.round((bottom - y) * zoom)) });
				record.view.setVisible(record.ready);
			} catch (error) {
				record?.view.setVisible(false);
				// Frames can disappear during a workspace switch or editor close.
				if (!/destroyed|disposed|frame|context/i.test(error.message)) { console.error('Trello view:', error.message); }
			} finally { busy = false; }
		};
		const timer = setInterval(() => { void sync(); }, 150); timer.unref();
		window.on('resize', () => { record?.view.setVisible(false); void sync(); });
		window.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => { if (main && !inPlace) { disposeView(); } });
		window.on('closed', () => { disposed = true; clearInterval(timer); disposeView(); });
	});
}
module.exports = { install, findHost };
