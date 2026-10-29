'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startRpc } = require('../../extensions/zilpio-codex/rpc.js');
const { readAuthentication } = require('../../extensions/zilpio-codex/backend.js');
const { OfficialProfiles } = require('../../extensions/zilpio-codex/official-profiles.js');
(async () => {
	const root = path.resolve(__dirname, '../..');
	const binary = path.join(root, '.build/clean-host/2a59476c9b/resources/app/extensions/openai.chatgpt/bin/windows-x86_64/codex.exe');
	const db = JSON.parse(fs.readFileSync(path.join(root, '.build/preview-user-recovery/User/globalStorage/zilpio.zilpio-codex/profiles.json'), 'utf8'));
	const profiles = [], credentials = new Map();
	for (const profile of db.profiles) {
		try {
			const auth = await readAuthentication(binary, profile);
			if (['chatgptAuthTokens', 'apiKey'].includes(auth.type) && !profiles.some(p => credentials.get(p.id).type === auth.type)) { profiles.push(profile); credentials.set(profile.id, auth); }
		} catch { /* Unconnected profiles are irrelevant to this read-only smoke test. */ }
		if (profiles.length === 2) { break; }
	}
	const chatgpt = profiles.find(p => credentials.get(p.id).type === 'chatgptAuthTokens');
	const api = profiles.find(p => credentials.get(p.id).type === 'apiKey');
	assert.ok(chatgpt && api, 'One connected ChatGPT profile and one API profile are required.');
	const home = path.join(root, '.build/api-auth-smoke-home'); fs.mkdirSync(home, { recursive: true });
	const worker = startRpc(binary, home, true);
	try {
		await worker.initialize();
		await worker.request('account/login/start', credentials.get(chatgpt.id));
		await assert.rejects(worker.request('account/login/start', credentials.get(api.id)), /External auth is active/);
		let selected = chatgpt.id; const methods = [];
		const service = new OfficialProfiles({
			store: { load: async () => ({ profiles }), select: async id => { selected = id; } },
			binary: async () => binary, authenticate: async (_, p) => credentials.get(p.id),
			request: (method, params) => { methods.push(method); return worker.request(method, params); }
		});
		service.current = chatgpt;
		await service.switch(api.id);
		assert.equal((await worker.request('account/read', { refreshToken: false })).account.type, 'apiKey');
		assert.equal(selected, api.id);
		await service.switch(chatgpt.id);
		assert.equal((await worker.request('account/read', { refreshToken: false })).account.type, 'chatgpt');
		assert.equal(selected, chatgpt.id);
		assert.ok(!methods.some(method => method.startsWith('turn/') || ['thread/start', 'thread/resume'].includes(method)));
		assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
		console.log('PASS: reproduced native external-auth rejection; ChatGPT → API key → ChatGPT succeeds in one engine, without turns or persisted credentials.');
	} finally { worker.dispose(); }
})().catch(() => { console.error('Native API authentication smoke test failed.'); process.exit(1); });
