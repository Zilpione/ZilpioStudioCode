/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, writeJson } = require('./profiles.js');
const { startRpc } = require('./rpc.js');
const pending = new Map();

/** Run a credential helper without keeping its databases or configuration in the account. */
function withAccountRpc(binary, profile, action, createRpc = startRpc) {
	const key = path.resolve(profile.home).toLowerCase();
	const lock = new ProfileStore(profile.home, [], { fileName: 'auth-helper.json' });
	const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => lock.serialize(async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-auth-'));
		let worker;
		let preserve = false;
		try {
			try { await fs.writeFile(path.join(home, 'auth.json'), await fs.readFile(path.join(profile.home, 'auth.json')), { mode: 0o600, flag: 'wx' }); }
			catch (error) { if (error.code !== 'ENOENT') { throw error; } }
			worker = createRpc(binary, home, false, ['-c', 'cli_auth_credentials_store="file"']);
			return await action(worker, home);
		} finally {
			try {
				if (worker) {
					worker.dispose();
					await worker.exited;
					// Refresh can succeed even if the subsequent request fails.
					try {
						const auth = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'));
						await writeJson(path.join(profile.home, 'auth.json'), auth);
					} catch (error) {
						if (error.code !== 'ENOENT') {
							preserve = true;
							throw new Error(`Impossibile salvare le credenziali. Copia di recupero in ${home}`, { cause: error });
						}
					}
				}
			} finally { if (!preserve) { await fs.rm(home, { recursive: true, force: true }); } }
		}
	})).finally(() => { if (pending.get(key) === result) { pending.delete(key); } });
	pending.set(key, result);
	return result;
}

module.exports = { withAccountRpc };
