const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ModelSettings } = require('../../extensions/zilpio-codex/model-settings.js');
const { filterModels } = require('../../extensions/zilpio-codex/media/model-settings-ui.js');
const catalog = [
	{ model: 'visible', displayName: 'Visible', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
	{ model: 'hidden', displayName: 'Hidden', hidden: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'max' }] }
];
const native = { models: [catalog[0]], defaultModel: catalog[0], hasModelSupportingMaxReasoningEffort: false, hasModelSupportingUltraReasoningEffort: false };
test('full paginated catalog, persistence, per-model efforts and preservation across accounts', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-models-'));
	try {
		const store = new ModelSettings(root, async (method, params) => {
			assert.equal(method, 'model/list'); assert.equal(params.includeHidden, true);
			return params.cursor ? { data: [catalog[1]], nextCursor: null } : { data: [catalog[0]], nextCursor: 'page2' };
		});
		assert.deepEqual(await store.catalog(), catalog);
		assert.equal(await store.load(), null);
		const choices = { visible: { enabled: false, efforts: ['low'] }, hidden: { enabled: true, efforts: ['max'] } };
		const saved = await store.save(choices, catalog);
		assert.deepEqual(await new ModelSettings(root).load(), saved);
		const result = filterModels(catalog, native, saved);
		assert.equal(result.models.length, 1); assert.equal(result.models[0].model, 'hidden'); assert.equal(result.models[0].hidden, false);
		assert.deepEqual(result.models[0].supportedReasoningEfforts, [{ reasoningEffort: 'max' }]);
		assert.equal(result.models[0].defaultReasoningEffort, 'max'); assert.equal(result.defaultModel.model, 'hidden'); assert.equal(result.hasModelSupportingMaxReasoningEffort, true);
		assert.equal(catalog[1].hidden, true);
		await store.save({ visible: { enabled: true, efforts: ['low'] } }, [catalog[0]]);
		assert.equal((await store.load()).models.hidden.enabled, true);
		await assert.rejects(store.save({ visible: { enabled: true, efforts: ['ultra'] } }, [catalog[0]]), /non supportato/);
		await assert.rejects(store.save({ visible: { enabled: true, efforts: [] } }, [catalog[0]]), /almeno un effort/);
		await assert.rejects(store.save({ visible: { enabled: false, efforts: [] } }, [catalog[0]]), /almeno un modello/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('original picker before customization and safe fallback for an account without chosen models', () => {
	assert.equal(filterModels(catalog, native, null), native);
	assert.equal(filterModels(catalog, native, { models: {} }), native);
});
test('blacklisted models never return through the native fallback', () => {
	const result = filterModels(catalog, native, { models: { visible: { enabled: true, efforts: ['low'], blacklisted: true } } });
	assert.equal(result.models.length, 0); assert.equal(result.defaultModel, null);
});

test('Astra is available explicitly but never the automatic default', () => {
	const astra = { ...catalog[0], model: 'gpt-6-astra' };
	const luna = { ...catalog[0], model: 'gpt-6-luna', isDefault: false };
	for (const preferences of [null, { models: {} }]) {
		const result = filterModels([astra, luna], { ...native, models: [astra, luna], defaultModel: astra }, preferences);
		assert.deepEqual([result.defaultModel.model, result.models.map(m => m.model)], ['gpt-6-luna', ['gpt-6-astra', 'gpt-6-luna']]);
	}
	assert.equal(filterModels([astra], { ...native, models: [astra], defaultModel: astra }, null).defaultModel, null);
});
