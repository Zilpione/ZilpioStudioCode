const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let ProfileStore;
try { ({ ProfileStore } = require('../../extensions/zilpio-codex/profiles.js')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') { throw error; } }

async function fixture(t) {
	assert.equal(typeof ProfileStore, 'function', 'ProfileStore must implement profile persistence');
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-profiles-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return { root, store: new ProfileStore(root, [], { userHome: path.join(root, 'user') }) };
}

test('creates and persists an isolated environment with no copied credentials', async t => {
	const { root, store } = await fixture(t);
	await store.load();
	const profile = await store.create('Example Test');
	assert.equal(profile.name, 'Example Test');
	assert.equal(path.dirname(profile.home), path.join(root, 'user', '.codex-account'));
	assert.deepEqual(await fs.readdir(profile.home), []);
	assert.deepEqual((await new ProfileStore(root, []).load()).profiles, [profile]);
});

test('does not overwrite corrupt registry or allow relative account homes', async t => {
	const { root, store } = await fixture(t);
	await fs.writeFile(path.join(root, 'profiles.json'), '{invalid');
	await assert.rejects(store.load(), /JSON/);
	assert.equal(await fs.readFile(path.join(root, 'profiles.json'), 'utf8'), '{invalid');
	await fs.writeFile(path.join(root, 'profiles.json'), JSON.stringify({ version: 1, activeProfileId: null, profiles: [{ id: 'x', name: 'X', home: '../x', provider: 'openai' }] }));
	await assert.rejects(store.load(), /absolute/);
});

test('rejects duplicate names and path traversal and serializes concurrent creation', async t => {
	const { store } = await fixture(t);
	await store.load();
	await assert.rejects(store.create('../escape'), /name/);
	await Promise.all([store.create('First'), store.create('Second')]);
	await assert.rejects(store.create('first'), /already/);
	assert.equal((await store.load()).profiles.length, 2);
});

test('active profile changes are persisted and unknown ids rejected', async t => {
	const { root, store } = await fixture(t);
	await store.load();
	const profile = await store.create('Zilpio');
	await store.select(profile.id);
	assert.equal((await new ProfileStore(root, []).load()).activeProfileId, profile.id);
	await assert.rejects(store.select('missing'), /Unknown/);
});

test('seed import includes only existing homes and never secrets', async t => {
	const { root } = await fixture(t);
	const existing = path.join(root, 'existing');
	await fs.mkdir(existing);
	const store = new ProfileStore(path.join(root, 'data'), [{ id: 'existing', name: 'Existing', home: existing, provider: 'openai' }, { id: 'absent', name: 'Absent', home: path.join(root, 'absent'), provider: 'openai' }]);
	const db = await store.load();
	assert.deepEqual(db.profiles.map(p => p.id), ['existing']);
	assert.equal(db.activeProfileId, 'existing');
});

test('failed atomic writes preserve the database and remove the empty environment', async t => {
	const { root, store } = await fixture(t);
	await store.load();
	const prior = await fs.readFile(store.file, 'utf8');
	const rename = fs.rename;
	fs.rename = async () => { throw new Error('Simulated write failure'); };
	try { await assert.rejects(store.create('Failed'), /Simulated write failure/); }
	finally { fs.rename = rename; }
	assert.equal(await fs.readFile(store.file, 'utf8'), prior);
	assert.deepEqual(await fs.readdir(path.join(root, 'user', '.codex-account')), []);
});

test('recovers a registry lock left by a terminated extension host', async t => {
	const { root, store } = await fixture(t);
	await store.load();
	await fs.writeFile(path.join(root, 'profiles.lock'), '2147483647');
	const kill = process.kill;
	process.kill = (pid, signal) => { if (pid === 2147483647 && signal === 0) { throw Object.assign(new Error('No process'), { code: 'ESRCH' }); } return kill(pid, signal); };
	try { assert.equal((await store.create('Recovered')).name, 'Recovered'); }
	finally { process.kill = kill; }
	assert.equal(await fs.stat(path.join(root, 'profiles.lock')).then(() => true, () => false), false);
});

test('a fresh clone uses example defaults while local account defaults take precedence', async t => {
	const { root } = await fixture(t);
	await fs.copyFile(path.resolve(__dirname, '../../extensions/zilpio-codex/profiles.js'), path.join(root, 'profiles.js'));
	const example = [{ id: 'default', name: 'Default', provider: 'openai', home: '~/example' }];
	await fs.writeFile(path.join(root, 'profiles.example.json'), JSON.stringify({ version: 1, profiles: example }));
	const { loadSeedProfiles } = require(path.join(root, 'profiles.js'));
	assert.deepEqual(loadSeedProfiles(), example);
	const local = [{ id: 'local', name: 'Custom account', provider: 'openai', home: '~/custom' }];
	await fs.writeFile(path.join(root, 'profiles.json'), JSON.stringify({ version: 1, profiles: local }));
	assert.deepEqual(loadSeedProfiles(), local);
	await fs.writeFile(path.join(root, 'profiles.json'), '{invalid');
	assert.throws(loadSeedProfiles, SyntaxError);
});
