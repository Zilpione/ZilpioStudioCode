/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { execFileSync } = require('node:child_process');
const { migrateStorage, needsStorageMigration } = require('../extensions/zilpio-codex/storage-migration.js');
const root = process.argv[2];
if (!root) { throw new Error('Specificare la cartella del registro Zilpio.'); }
if (needsStorageMigration(root)) {
	if (process.platform === 'win32') {
		const running = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name ZSCode.Editor -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8', windowsHide: true }).trim();
		if (Number(running) !== 0) { throw new Error('Chiudi tutte le finestre ZilpioStudioCode e riapri ZSCode.exe per migrare account ed environment.'); }
	}
	migrateStorage(root);
	console.log('Account ed environment Zilpio migrati. Dati originali degli account conservati.');
}
