/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The main process owns the allowlist. The page receives no filesystem or IPC API.
contextBridge.exposeInMainWorld('__zilpioTrello', {
	navigate: (url, external = false) => ipcRenderer.sendSync('zilpio:trello:navigate', String(url), external === true)
});
contextBridge.executeInMainWorld({ func: () => {
	const permit = (value, external = false) => {
		try { return window.__zilpioTrello.navigate(new URL(value, location.href).href, external); } catch { return false; }
	};
	for (const name of ['pushState', 'replaceState']) {
		const original = history[name];
		history[name] = function (...args) {
			if (args[2] != null && !permit(args[2])) { throw new DOMException('Navigation is restricted to the project board.', 'SecurityError'); }
			return Reflect.apply(original, this, args);
		};
	}
	document.addEventListener('click', event => {
		const anchor = event.target.closest?.('a[href]');
		if (anchor && !permit(anchor.href, true)) { event.preventDefault(); event.stopImmediatePropagation(); }
	}, true);
	document.addEventListener('auxclick', event => {
		const anchor = event.target.closest?.('a[href]');
		if (anchor && !permit(anchor.href, true)) { event.preventDefault(); event.stopImmediatePropagation(); }
	}, true);
	// Hide navigation affordances; enforcement above and in Electron is independent of CSS.
	const style = () => {
		if (!document.documentElement || document.getElementById('zilpio-board-navigation')) { return; }
		const sheet = document.createElement('style'); sheet.id = 'zilpio-board-navigation';
		sheet.textContent = '[data-testid="header-boards-menu-button"], [data-testid="header-home-button"], [data-testid="workspace-navigation"], [data-testid="workspace-navigation-nav"], [data-testid="board-switcher-button"], [data-testid="header-switcher-button"], #workspace-navigation { display:none !important; }';
		document.documentElement.append(sheet);
	};
	if (document.documentElement) { style(); } else { document.addEventListener('DOMContentLoaded', style, { once: true }); }
} });
