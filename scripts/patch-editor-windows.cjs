/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

// The preview uses a packaged host. Take the changed method from our source so
// the preview and a future source build keep the same window/backup behavior.
const app = process.argv[2];
if (!app) { throw new Error('Indica la cartella resources/app dell’host Zilpio.'); }
const bundlePath = path.join(app, 'out/mainImpl.js');
const backup = bundlePath + '.zilpio-windows-original';
if (!fs.existsSync(backup)) { fs.copyFileSync(bundlePath, backup); }
let bundle = fs.readFileSync(backup, 'utf8');
if (!bundle.includes('let w=r.length+t.length+o.length;if(a&&w===0)')) { throw new Error('Selezione delle finestre dell’host non riconosciuta.'); }
function replaceOnce(from, to) {
	if (bundle.split(from).length !== 2) { throw new Error('Gestione finestre dell’host non riconosciuta: ' + from); }
	bundle = bundle.replace(from, to);
}
for (const field of ['configPath', 'uri']) {
	replaceOnce(`Lo(this.getWindows(),E.workspace.${field})`, `Lo(this.getWindows().filter(window=>w===0||(!g&&(e.contextWindowId===undefined||window.id===e.contextWindowId))),E.workspace.${field})`);
}
const source = fs.readFileSync(path.join(__dirname, '../src/vs/platform/windows/electron-main/windowsMainService.ts'), 'utf8');
const start = source.indexOf('\tprivate async doOpenFolderOrWorkspace(');
const end = source.indexOf('\n\tprivate ', start + 1);
if (start < 0 || end < 0) { throw new Error('Metodo sorgente di apertura finestre non trovato.'); }
let method = stripTypeScriptTypes(`class WindowPatch {\n${source.slice(start, end)}\n}`).replace(/^class WindowPatch \{/, '').replace(/\}\s*$/, '');
const symbols = { findWindowOnWorkspaceOrFolder: 'Lo', isWorkspaceIdentifier: 'St', extUriBiasedIgnorePathCase: 'Ge', URI: 'C', parse: 'Or', fs: 'ub' };
for (const [name, compiled] of Object.entries(symbols)) { method = method.replace(new RegExp(`(?<![.\\w$])${name}\\b`, 'g'), compiled); }
if (!bundle.includes('doParseStoredWorkspace(e,t){let r=Or(t)') || !bundle.includes('ub.promises.readFile(t,"utf8")') || !bundle.includes('St(t.workspace)?t.backupPath') || !bundle.includes('get cacheHome(){return C.file(this.userDataPath)}')) { throw new Error('Simboli dell’host non riconosciuti.'); }
const compiledStart = bundle.indexOf('doOpenFolderOrWorkspace(e,t,r,o,s){');
const compiledEnd = bundle.indexOf('async getPathsToOpen(', compiledStart);
if (compiledStart < 0 || compiledEnd < 0) { throw new Error('Metodo di apertura dell’host non riconosciuto.'); }
bundle = bundle.slice(0, compiledStart) + method + bundle.slice(compiledEnd);
fs.writeFileSync(bundlePath, bundle);
console.log('Apertura dello stesso workspace in più finestre abilitata.');
