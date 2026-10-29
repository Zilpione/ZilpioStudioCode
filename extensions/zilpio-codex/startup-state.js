/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeJson } = require('./profiles.js');
const { WorkspaceStore } = require('./workspaces.js');

class StartupState {
	constructor(root) { this.root = root; this.file = path.join(root, 'last-prompt.json'); }
	async load() {
		try {
			const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
			if (value.version !== 1 || !path.isAbsolute(value.project) || !['accountId', 'environmentId'].every(key => typeof value[key] === 'string' && /^[\w-]+$/.test(value[key]))) { throw new Error('Ultimo prompt non valido.'); }
			return value;
		} catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
	}
	async record({ project, accountId, environmentId, params }) {
		if (!project || !accountId || !environmentId) { return; }
		const settings = params.collaborationMode?.settings;
		await fs.mkdir(this.root, { recursive: true });
		await writeJson(this.file, { version: 1, project, accountId, environmentId,
			model: settings?.model ?? params.model ?? null,
			reasoningEffort: settings?.reasoning_effort ?? params.effort ?? null,
			serviceTier: params.serviceTier ?? null });
	}
	async restore() {
		const saved = await this.load();
		if (!saved) { return null; }
		try { if (!(await fs.stat(saved.project)).isDirectory()) { return null; } }
		catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
		for (const [file, id] of [['profiles', saved.accountId], ['environments', saved.environmentId]]) {
			const db = JSON.parse(await fs.readFile(path.join(this.root, file + '.json'), 'utf8'));
			if (!db.profiles.some(profile => profile.id === id)) { return null; }
		}
		const key = process.platform === 'win32' ? path.resolve(saved.project).toLowerCase() : path.resolve(saved.project);
		await new WorkspaceStore(this.root).update(db => {
			db.selections[key] = { id: db.selections[key]?.id ?? db.workspaces.find(card => path.resolve(card.folder).toLowerCase() === key.toLowerCase())?.id ?? 'last-prompt', accountId: saved.accountId, environmentId: saved.environmentId };
		});
		return saved.project;
	}
}
module.exports = { StartupState };
if (require.main === module) {
	new StartupState(process.argv[2]).restore().then(project => { if (project) { process.stdout.write(project); } }).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
}
