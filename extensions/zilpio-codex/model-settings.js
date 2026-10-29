'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
class ModelSettings {
	constructor(root, request) { this.file = path.join(root, 'model-settings.json'); this.request = request; }
	async load() {
		try {
			const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
			if (value.version !== 1 || !value.models || typeof value.models !== 'object' || Array.isArray(value.models)) { throw new Error('Impostazioni modelli non valide.'); }
			return value;
		} catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
	}
	async catalog() {
		const models = []; let cursor = null;
		do {
			const page = await this.request('model/list', { includeHidden: true, limit: 100, cursor });
			models.push(...page.data); cursor = page.nextCursor;
		} while (cursor);
		return models;
	}
	async save(input, catalog) {
		if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new Error('Selezione non valida.'); }
		const models = Object.create(null);
		for (const model of catalog) {
			const choice = input[model.model];
			if (!choice || typeof choice.enabled !== 'boolean' || !Array.isArray(choice.efforts)) { throw new Error('Selezione incompleta. Aggiorna il catalogo.'); }
			const supported = model.supportedReasoningEfforts.map(e => e.reasoningEffort);
			if (choice.efforts.some(e => !supported.includes(e))) { throw new Error('Effort non supportato per ' + model.displayName); }
			if (choice.enabled && !choice.blacklisted && supported.length && !choice.efforts.length) { throw new Error('Scegli almeno un effort per ' + model.displayName); }
			models[model.model] = { enabled: choice.blacklisted ? false : choice.enabled, efforts: supported.filter(e => choice.efforts.includes(e)), ...(choice.blacklisted ? { blacklisted: true } : {}) };
		}
		if (!Object.values(models).some(m => m.enabled)) { throw new Error('Mantieni almeno un modello selezionato.'); }
		const previous = await this.load();
		const value = { version: 1, models: { ...previous?.models, ...models } };
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		const temp = this.file + '.tmp';
		await fs.writeFile(temp, JSON.stringify(value, null, '\t') + '\n');
		await fs.rename(temp, this.file);
		return value;
	}
}
module.exports = { ModelSettings };
