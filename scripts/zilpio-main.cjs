'use strict';
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const launcher = process.env.ZILPIO_LAUNCHER;
const icon = process.env.ZILPIO_APP_ICON;
const logo = process.env.ZILPIO_APP_LOGO;
const appId = 'ZilpioStudioCode.Editor';
if (process.platform === 'win32' && launcher && fs.existsSync(launcher)) {
	app.setAppUserModelId(appId);
	// Recent projects must use the launcher too: a bare editor loses our data,
	// extensions and Codex environment when Explorer starts it.
	const setJumpList = app.setJumpList.bind(app);
	app.setJumpList = categories => setJumpList(categories?.map(category => ({
		...category,
		...(category.items ? { items: category.items.map(item =>
			item.type === 'task' && item.program?.toLowerCase() === process.execPath.toLowerCase()
				? { ...item, program: launcher, ...(item.iconPath?.toLowerCase() === process.execPath.toLowerCase() ? { iconPath: icon } : {}) }
				: item) } : {})
	})) ?? categories);
	app.on('browser-window-created', (_, window) => {
		window.setAppDetails({ appId, appIconPath: icon, relaunchCommand: `"${launcher}"`, relaunchDisplayName: 'ZSCode' });
		window.setIcon(icon);
		if (logo && fs.existsSync(logo)) {
			const image = fs.readFileSync(logo).toString('base64');
			const watermarkFile = path.join(path.dirname(launcher), 'resources/win32/zscode-app.png');
			const watermark = fs.readFileSync(fs.existsSync(watermarkFile) ? watermarkFile : logo).toString('base64');
			window.webContents.on('did-finish-load', () => {
				void window.webContents.insertCSS(`.monaco-workbench .part.titlebar .window-appicon { background-image: url("data:image/png;base64,${image}") !important; background-position: center !important; background-repeat: no-repeat !important; background-size: 20px !important; } .monaco-workbench .part.titlebar .window-appicon::before { display: none !important; } .monaco-workbench .part.editor .editor-group-watermark .letterpress { background-image: url("data:image/png;base64,${watermark}") !important; background-position: center !important; background-repeat: no-repeat !important; background-size: contain !important; }`).catch(error => console.error('ZSCode workbench icons:', error));
			});
		}
	});
	app.whenReady().then(() => {
		const shortcut = path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs/ZSCode.lnk');
		const options = { target: launcher, cwd: path.dirname(launcher), description: 'ZilpioStudioCode', icon, iconIndex: 0, appUserModelId: appId };
		if (!shell.writeShortcutLink(shortcut, fs.existsSync(shortcut) ? 'update' : 'create', options)) { console.error('Impossibile creare il collegamento ZSCode.'); }
		const pinned = path.join(app.getPath('appData'), 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar');
		for (const name of fs.existsSync(pinned) ? fs.readdirSync(pinned) : []) {
			if (!name.toLowerCase().endsWith('.lnk')) { continue; }
			const file = path.join(pinned, name);
			let existing;
			try { existing = shell.readShortcutLink(file); } catch { continue; }
			if (existing.target.toLowerCase() !== process.execPath.toLowerCase()) { continue; }
			const backup = path.join(path.dirname(launcher), '.build/taskbar-shortcut-backups', name);
			fs.mkdirSync(path.dirname(backup), { recursive: true });
			if (!fs.existsSync(backup)) { fs.copyFileSync(file, backup); }
			shell.writeShortcutLink(file, 'update', { ...options, args: '' });
		}
	});
}
if (require('electron').WebContentsView) { require('./trello-main.cjs').install(); }
import('./out/main.js').catch(error => { console.error(error); app.exit(1); });
