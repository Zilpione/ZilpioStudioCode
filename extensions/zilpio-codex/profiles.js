/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

async function writeJson(file, data) {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
		await fs.rename(temp, file);
	} finally {
		await fs.rm(temp, { force: true });
	}
}

function validate(db) {
	if (!db || db.version !== 1 || !Array.isArray(db.profiles)) { throw new Error('Invalid profiles JSON: expected version 1 and profiles array.'); }
	const ids = new Set();
	const names = new Set();
	for (const p of db.profiles) {
		if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.provider !== 'openai') { throw new Error('Invalid profile in JSON. Only provider openai is supported.'); }
		if (typeof p.home !== 'string' || !path.isAbsolute(p.home)) { throw new Error('Profile home must be an absolute path.'); }
		if (ids.has(p.id) || names.has(p.name.toLowerCase())) { throw new Error('Profile already exists: duplicate id or name.'); }
		ids.add(p.id);
		names.add(p.name.toLowerCase());
	}
	if (db.activeProfileId !== null && !ids.has(db.activeProfileId)) { throw new Error('Unknown active profile in JSON.'); }
	return db;
}

class ProfileStore {
	constructor(root, seeds = [], { fileName = 'profiles.json', includeMissingSeeds = false, userHome = os.homedir() } = {}) {
		this.root = root;
		this.file = path.join(root, fileName);
		this.lockFile = this.file.replace(/\.json$/, '.lock');
		this.includeMissingSeeds = includeMissingSeeds;
		this.seeds = seeds;
		this.userHome = userHome;
		this.queue = Promise.resolve();
	}
	serialize(fn) {
		const result = this.queue.then(async () => {
			await fs.mkdir(this.root, { recursive: true });
			const lockFile = this.lockFile;
			let lock;
			try { lock = await fs.open(lockFile, 'wx', 0o600); }
			catch (error) {
				if (error.code !== 'EEXIST') { throw error; }
				const owner = Number(await fs.readFile(lockFile, 'utf8'));
				if (!Number.isSafeInteger(owner) || owner <= 0) { throw new Error(`Profile lock has no valid owner. Close other editor windows and remove ${lockFile}.`); }
				try { process.kill(owner, 0); }
				catch (error) {
					if (error.code !== 'ESRCH') { throw new Error('Another window is editing the profile registry.'); }
					await fs.unlink(lockFile);
					lock = await fs.open(lockFile, 'wx', 0o600);
				}
				if (!lock) { throw new Error('Another window is editing the profile registry. Retry after it finishes.'); }
			}
			try { await lock.writeFile(String(process.pid)); return await fn(); }
			finally { await lock.close(); await fs.unlink(lockFile); }
		});
		this.queue = result.catch(() => {});
		return result;
	}
	async load() {
		await fs.mkdir(this.root, { recursive: true });
		try { return validate(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
		catch (error) {
			if (error.code !== 'ENOENT') { throw error; }
			const profiles = [];
			for (const seed of this.seeds) {
				const home = seed.home.startsWith('~/') ? path.join(os.homedir(), seed.home.slice(2)) : seed.home;
				if (this.includeMissingSeeds) { profiles.push({ ...seed, home }); continue; }
				try { if ((await fs.stat(home)).isDirectory()) { profiles.push({ id: seed.id, name: seed.name, provider: seed.provider, home }); } }
				catch (error) { if (error.code !== 'ENOENT') { throw error; } }
			}
			const db = validate({ version: 1, activeProfileId: profiles[0]?.id ?? null, profiles });
			// Exclusive initial creation preserves another window's existing database.
			try { await fs.writeFile(this.file, JSON.stringify(db, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
			catch (error) { if (error.code === 'EEXIST') { return this.load(); } throw error; }
			return db;
		}
	}
	create(name) {
		return this.serialize(async () => {
			if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,60}$/u.test(name.trim())) { throw new Error('Invalid environment name. Use letters, numbers, spaces, _ or -.'); }
			name = name.trim();
			const db = await this.load();
			if (db.profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) { throw new Error('An environment with this name already exists.'); }
			const id = randomUUID();
			const slug = name.toLowerCase().replace(/ +/g, '-');
			if (['account', 'chathistory-zscode'].includes(slug) && this.file.endsWith('environments.json')) { throw new Error('Nome environment riservato.'); }
			const home = this.file.endsWith('environments.json') ? path.join(this.userHome, `.codex-${slug}`) : path.join(this.userHome, '.codex-account', slug);
			if (db.profiles.some(p => path.resolve(p.home).toLowerCase() === path.resolve(home).toLowerCase())) { throw new Error('Cartella già usata da un altro profilo.'); }
			await fs.mkdir(path.dirname(home), { recursive: true });
			await fs.mkdir(home);
			const profile = { id, name, provider: 'openai', home };
			try { await writeJson(this.file, { ...db, profiles: [...db.profiles, profile] }); }
			catch (error) { await fs.rmdir(home); throw error; }
			return profile;
		});
	}
	select(id) {
		return this.serialize(async () => {
			const db = await this.load();
			if (!db.profiles.some(p => p.id === id)) { throw new Error('Unknown profile.'); }
			await writeJson(this.file, { ...db, activeProfileId: id });
		});
	}
}
function loadSeedProfiles() {
	const local = path.join(__dirname, 'profiles.json');
	const source = require('node:fs').existsSync(local) ? local : path.join(__dirname, 'profiles.example.json');
	return JSON.parse(require('node:fs').readFileSync(source, 'utf8')).profiles;
}
module.exports = { ProfileStore, writeJson, validate, loadSeedProfiles };
