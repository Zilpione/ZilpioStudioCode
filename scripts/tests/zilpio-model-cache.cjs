const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { filterModels } = require('../../extensions/zilpio-codex/media/model-settings-ui.js');
const source = fs.readFileSync('.build/clean-host/2a59476c9b/resources/app/extensions/openai.chatgpt/webview/assets/app-initial-c014f9ee4429.js', 'utf8');
const marker = 'queryFn:({queryKey:e})=>{window.zilpioRefreshModels';
const start = source.indexOf(marker), end = source.indexOf(',select:', start);
assert.ok(start >= 0 && end > start);
const catalog = JSON.parse(fs.readFileSync('.build/models-catalog-smoke.json', 'utf8')).catalog;
const native = { models: [catalog[0]], defaultModel: catalog[0] };
let preferences = null, invalidated = false;
const context = {
	window: { zilpioModelsRevision: 0, zilpioFilterModels: (catalog, native) => filterModels(catalog, native, preferences) },
	d: { getQueryData: () => ({ data: catalog }), invalidateQueries() { invalidated = true; } },
	g: ['models', 'local'], o: false, Bp: () => ({ sendRequest: async () => ({ data: catalog, nextCursor: null }) }),
	f: null, i: 'local', s: 100
};
const query = vm.runInNewContext('(' + source.slice(start + 'queryFn:'.length, end) + ')', context);
const selectStart = source.indexOf('select:({data:n})=>window.zilpioFilterModels', end);
const selectEnd = source.indexOf('}},{key:e=>JSON.stringify(e)})', selectStart);
Object.assign(context, { Cbe: () => native, e: [], h: false, t: 'chatgpt', v: {}, _: new Set(), r: false, y: true });
const select = vm.runInNewContext('(' + source.slice(selectStart + 'select:'.length, selectEnd) + ')', context);
(async () => {
	// Mirror the query observer's cache: select only runs again when result data changes.
	let previous, selected;
	const read = async () => {
		const result = await query({ queryKey: context.g });
		const key = JSON.stringify(result);
		if (key !== previous) { selected = select(result); previous = key; }
		return selected;
	};
	assert.equal((await read()).models.length, 1);
	preferences = { models: Object.fromEntries(catalog.map((m, i) => [m.model, { enabled: i < 2, efforts: ['high'], blacklisted: i === 2 }])) };
	context.window.zilpioModelsRevision++;
	context.window.zilpioRefreshModels();
	assert.equal(invalidated, true);
	assert.equal((await read()).models.length, 2);
	assert.deepEqual(selected.models.map(m => m.supportedReasoningEfforts.map(e => e.reasoningEffort)), [['high'], ['high']]);
	console.log('PASS: unchanged server catalog refreshes the native cached selector after settings change; two models and chosen efforts appear.');
})().catch(error => { console.error(error); process.exit(1); });
