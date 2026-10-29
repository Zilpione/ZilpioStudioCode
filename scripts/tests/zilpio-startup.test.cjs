/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { StartupState } = require('../../extensions/zilpio-codex/startup-state.js');

test('only accepted prompts persist a whitelisted snapshot; launch restores its project and selection', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-startup-'));
	try {
		const state = new StartupState(root);
		const project = path.join(root, 'project'); await fs.mkdir(project);
		await fs.writeFile(path.join(root, 'profiles.json'), JSON.stringify({ version: 1, activeProfileId: 'other', profiles: [{ id: 'account', name: 'A', provider: 'openai', home: root }] }));
		await fs.writeFile(path.join(root, 'environments.json'), JSON.stringify({ version: 1, activeProfileId: 'env', profiles: [{ id: 'env', name: 'E', provider: 'openai', home: root }] }));
		assert.equal(await state.restore(), null);
		await state.record({ project, accountId: 'account', environmentId: 'env', params: { threadId: 'thread', model: 'gpt-6-astra', effort: 'low', collaborationMode: { settings: { model: 'gpt-6-luna', reasoning_effort: 'high' } }, serviceTier: 'default', input: [{ text: 'PRIVATE PROMPT' }] } });
		const reopened = new StartupState(root);
		assert.deepEqual(await reopened.load(), { version: 1, project, accountId: 'account', environmentId: 'env', model: 'gpt-6-luna', reasoningEffort: 'high', serviceTier: 'default' });
		assert.equal(await reopened.restore(), project);
		const db = JSON.parse(await fs.readFile(path.join(root, 'workspaces.json'), 'utf8'));
		assert.deepEqual(Object.values(db.selections), [{ id: 'last-prompt', accountId: 'account', environmentId: 'env' }]);
		await fs.rm(project, { recursive: true });
		assert.equal(await reopened.restore(), null);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
