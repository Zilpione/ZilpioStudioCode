/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { validate } = require('./profiles.js');

function read(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') { throw error; } }
}

function write(file, value) {
	writeText(file, JSON.stringify(value, null, 2) + '\n');
}

function writeText(file, value) {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally { fs.rmSync(temporary, { force: true }); }
}

function same(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

function replacePathPrefix(text, source, target) {
	return text.replaceAll(source, (match, offset) => {
		const next = text[offset + match.length];
		return next === undefined || /[\\/\s"']/.test(next) ? target : match;
	});
}

/** Rebase only environment-owned paths; conversation contents and project paths stay intact. */
function relocateEnvironmentPaths(home, source, target) {
	const variants = [[source, target], [source.replace(/\\/g, '/'), target.replace(/\\/g, '/')]];
	if (process.platform === 'win32') { variants.push([path.toNamespacedPath(source), path.toNamespacedPath(target)]); }
	for (const file of fs.readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))) {
		const { DatabaseSync } = require('node:sqlite');
		const db = new DatabaseSync(path.join(home, file));
		try {
			db.exec('BEGIN IMMEDIATE');
			for (const [table, column] of [['threads', 'rollout_path'], ['rollout_migration_skipped_rollouts', 'rollout_path']]) {
				if (!db.prepare(`PRAGMA table_info(${table})`).all().some(field => field.name === column)) { continue; }
				for (const [from, to] of variants) {
					const separator = from.includes('\\') ? '\\' : '/';
					const prefix = from + separator;
					db.prepare(`UPDATE ${table} SET ${column} = ? || substr(${column}, length(?) + 1) WHERE substr(${column}, 1, length(?)) = ? COLLATE NOCASE`).run(to + separator, prefix, prefix, prefix);
				}
			}
			db.exec('COMMIT');
		} catch (error) { db.exec('ROLLBACK'); throw error; }
		finally { db.close(); }
	}
	for (const name of ['config.toml', '.codex-global-state.json']) {
		const file = path.join(home, name);
		if (!fs.existsSync(file)) { continue; }
		const prior = fs.readFileSync(file, 'utf8');
		let updated = prior;
		for (const [from, to] of variants) {
			updated = replacePathPrefix(replacePathPrefix(updated, from.replace(/\\/g, '\\\\'), to.replace(/\\/g, '\\\\')), from, to);
		}
		if (updated !== prior) { writeText(file, updated); }
	}
}

function folderName(name) {
	if (!/^[\p{L}\p{N} _-]{1,60}$/u.test(name.trim())) { throw new Error('Nome environment non valido per la migrazione.'); }
	const slug = name.trim().toLowerCase().replace(/ +/g, '-');
	if (['account', 'chathistory-zscode'].includes(slug)) { throw new Error('Nome environment riservato.'); }
	return slug;
}

/** Build the entire migration before changing directories or registries. */
function planStorage(root, userHome) {
	const original = path.join(userHome, '.codex');
	const seeds = require('./profiles.js').loadSeedProfiles().map(p => {
		const home = path.join(userHome, '.codex-account', p.id);
		const legacy = p.id === 'default' ? original : path.join(userHome, `.codex-account-${p.id}`);
		return { ...p, home: fs.existsSync(home) ? home : legacy };
	}).filter(p => fs.existsSync(p.home));
	const profilesBefore = validate(read(path.join(root, 'profiles.json')) ?? { version: 1, activeProfileId: seeds[0]?.id ?? null, profiles: seeds });
	const environmentsBefore = validate(read(path.join(root, 'environments.json')) ?? { version: 1, activeProfileId: 'work', profiles: [
		{ id: 'work', name: 'Work', provider: 'openai', home: fs.existsSync(path.join(userHome, '.codexchathistory-zscode')) ? path.join(userHome, '.codexchathistory-zscode') : path.join(userHome, '.codex-work') },
		{ id: 'codex', name: 'Codex', provider: 'openai', home: original }
	] });
	const profilesAfter = structuredClone(profilesBefore), environmentsAfter = structuredClone(environmentsBefore);
	const accounts = [], moves = [], targets = new Set();
	for (const profile of profilesAfter.profiles) {
		const target = path.join(userHome, '.codex-account', profile.id);
		if (same(profile.home, target) || same(path.dirname(profile.home), path.join(userHome, '.codex-account'))) { continue; }
		if (fs.existsSync(target)) { throw new Error(`Destinazione account già esistente: ${target}`); }
		accounts.push({ source: profile.home, target });
		profile.home = target;
	}
	for (const environment of environmentsAfter.profiles) {
		if (same(environment.home, original)) { continue; }
		const target = path.join(userHome, `.codex-${folderName(environment.name)}`);
		if (targets.has(target.toLowerCase())) { throw new Error('Conflitto fra nomi delle cartelle environment.'); }
		targets.add(target.toLowerCase());
		if (fs.existsSync(path.join(environment.home, 'auth.json'))) { throw new Error(`Sposta auth.json dall'environment ${environment.home} in un account prima della migrazione.`); }
		if (!same(environment.home, target)) {
			if (!(same(path.dirname(environment.home), userHome) && path.basename(environment.home).startsWith('.codex')) && !same(path.dirname(environment.home), path.join(root, 'environments'))) {
				throw new Error(`Percorso environment personalizzato: migrazione manuale necessaria per ${environment.home}`);
			}
			if (fs.existsSync(target)) { throw new Error(`Destinazione environment già esistente: ${target}`); }
			const identity = fs.existsSync(environment.home) ? String(fs.statSync(environment.home, { bigint: true }).ino) : null;
			if (identity !== null) { moves.push({ source: environment.home, target, identity }); }
			environment.home = target;
		}
	}
	const agentsBefore = read(path.join(root, 'agents.json'));
	const agentsAfter = agentsBefore === undefined ? undefined : structuredClone(agentsBefore);
	if (agentsAfter) {
		if (agentsAfter.version !== 1 || !Array.isArray(agentsAfter.agents) || !Array.isArray(agentsAfter.reservedNames)) { throw new Error('Registro agenti non valido.'); }
		for (const agent of agentsAfter.agents) {
			if (typeof agent.home !== 'string' || !path.isAbsolute(agent.home)) { throw new Error('Environment agente non valido.'); }
			const previous = environmentsBefore.profiles.find(p => same(p.home, agent.home));
			if (previous) { agent.home = environmentsAfter.profiles.find(p => p.id === previous.id).home; }
		}
	}
	return { version: 1, phase: 'pending', profilesBefore, environmentsBefore, profilesAfter, environmentsAfter, agentsBefore, agentsAfter, accounts, moves };
}

function needsStorageMigration(root) {
	return read(path.join(root, 'storage-migration.json'))?.phase !== 'complete';
}

/** Called only by the launcher with all Zilpio processes stopped. Journal permits crash recovery. */
function migrateStorage(root, userHome = os.homedir()) {
	if (!path.isAbsolute(root) || !path.isAbsolute(userHome)) { throw new Error('I percorsi della migrazione devono essere assoluti.'); }
	if (!needsStorageMigration(root)) { return; }
	fs.mkdirSync(root, { recursive: true });
	const lock = path.join(root, 'storage-migration.lock');
	if (fs.existsSync(lock)) {
		const owner = Number(fs.readFileSync(lock, 'utf8'));
		if (!Number.isSafeInteger(owner) || owner <= 0) { throw new Error('Lock migrazione non valido.'); }
		try { process.kill(owner, 0); throw new Error('Migrazione già in corso.'); }
		catch (error) { if (error.code !== 'ESRCH') { throw error; } fs.unlinkSync(lock); }
	}
	const handle = fs.openSync(lock, 'wx', 0o600);
	try {
		fs.writeFileSync(handle, String(process.pid));
		const journalFile = path.join(root, 'storage-migration.json');
		let journal = read(journalFile);
		if (!journal) { journal = planStorage(root, userHome); write(journalFile, journal); }
		if (journal.version !== 1 || journal.phase !== 'pending') { throw new Error('Registro migrazione non valido.'); }
		for (const { source, target } of journal.accounts) {
			fs.mkdirSync(target, { recursive: true });
			const auth = path.join(source, 'auth.json'), destination = path.join(target, 'auth.json');
			if (fs.existsSync(auth)) {
				if (fs.existsSync(destination)) {
					if (!fs.readFileSync(auth).equals(fs.readFileSync(destination))) { throw new Error('Credenziali diverse nella destinazione della migrazione.'); }
				} else { fs.writeFileSync(destination, fs.readFileSync(auth), { flag: 'wx', mode: 0o600 }); }
			}
		}
		for (const { source, target, identity } of journal.moves) {
			if (fs.existsSync(source)) {
				if (fs.existsSync(target)) { throw new Error(`Destinazione environment già esistente: ${target}`); }
				fs.renameSync(source, target);
			} else if (fs.existsSync(target)) {
				if (identity !== String(fs.statSync(target, { bigint: true }).ino)) { throw new Error('Destinazione environment cambiata durante la migrazione.'); }
			} else { throw new Error('Cartella environment scomparsa durante la migrazione.'); }
			relocateEnvironmentPaths(target, source, target);
		}
		write(path.join(root, 'profiles.json'), journal.profilesAfter);
		write(path.join(root, 'environments.json'), journal.environmentsAfter);
		if (journal.agentsAfter) { write(path.join(root, 'agents.json'), journal.agentsAfter); }
		journal.phase = 'complete';
		write(journalFile, journal);
	} finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

module.exports = { migrateStorage, needsStorageMigration, relocateEnvironmentPaths };
