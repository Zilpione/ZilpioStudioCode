(function () {
	'use strict';
	const isAstra = model => /(?:^|[-_])astra(?:$|[-_])/i.test(model || '');
	function safeDefault(native) {
		if (!isAstra(native.defaultModel?.model)) { return native; }
		const models = native.models.filter(model => !isAstra(model.model));
		return { ...native, defaultModel: models.find(model => /(?:^|[-_])luna(?:$|[-_])/i.test(model.model)) || models[0] || null };
	}
	function filterModels(catalog, native, preferences) {
		native = safeDefault(native);
		if (!preferences) { return native; }
		const selected = catalog.flatMap(model => {
			const choice = preferences.models[model.model];
			if (!choice?.enabled || choice.blacklisted) { return []; }
			const efforts = model.supportedReasoningEfforts.filter(e => choice.efforts.includes(e.reasoningEffort));
			if (model.supportedReasoningEfforts.length && !efforts.length) { return []; }
			return [{ ...model, hidden: false, supportedReasoningEfforts: efforts,
				defaultReasoningEffort: efforts.some(e => e.reasoningEffort === model.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts[0]?.reasoningEffort ?? model.defaultReasoningEffort }];
		});
		const models = selected.length ? selected : native.models.filter(model => !preferences.models[model.model]?.blacklisted);
		if (!selected.length && models.length === native.models.length) { return native; }
		return safeDefault({ ...native, models,
			defaultModel: models.find(m => m.model === native.defaultModel?.model) || models.find(m => m.isDefault) || models[0] || null,
			hasModelSupportingMaxReasoningEffort: models.some(m => m.supportedReasoningEfforts.some(e => e.reasoningEffort === 'max')),
			hasModelSupportingUltraReasoningEffort: models.some(m => m.supportedReasoningEfforts.some(e => e.reasoningEffort === 'ultra')) });
	}
	if (typeof module === 'object' && module.exports) { module.exports = { filterModels }; return; }
	let api, button, dialog, list, blacklist, blacklistBody, blacklistSummary, status, save, search, state, preferences, defaultModels = [], requestNumber = 0, dialogRequest;
	let startup = null, manuallySelected = false, tierSelected = false;
	try { startup = JSON.parse(decodeURIComponent(document.querySelector('meta[name="zilpio-startup"]')?.content || 'null')); } catch { /* Safe catalog default still applies. */ }
	function startupModel(settings, isNewThread) {
		if (!isNewThread || manuallySelected) { return settings; }
		const saved = !isAstra(startup?.model) && defaultModels.find(model => model.model === startup?.model);
		const fallback = safeDefault({ models: defaultModels, defaultModel: defaultModels.find(model => model.model === settings.model) }).defaultModel;
		const model = saved || (isAstra(settings.model) ? fallback : null);
		return model ? { ...settings, model: model.model, reasoningEffort: saved && model.supportedReasoningEfforts.some(e => e.reasoningEffort === startup.reasoningEffort) ? startup.reasoningEffort : model.defaultReasoningEffort } : isAstra(settings.model) ? { ...settings, model: 'gpt-6-luna', reasoningEffort: 'medium' } : settings;
	}
	window.zilpioStartupModel = (settings, isNewThread) => {
		const result = startupModel(settings, isNewThread);
		if (window.zilpioActiveModel?.model !== result.model || window.zilpioActiveModel?.reasoningEffort !== result.reasoningEffort) {
			window.zilpioActiveModel = result;
			window.dispatchEvent(new Event('zilpio-model-changed'));
		}
		return result;
	};
	window.zilpioModelSelected = () => { manuallySelected = true; };
	window.zilpioStartupTier = (tier, isNewThread) => isNewThread && !tierSelected && startup ? startup.serviceTier ?? 'default' : tier;
	window.zilpioTierSelected = () => { tierSelected = true; };
	function request(action, values = {}, fromDialog = false) {
		const requestId = `zilpio-models-${++requestNumber}`;
		if (fromDialog) { dialogRequest = requestId; }
		api.postMessage({ type: 'zilpio-models', action, requestId, ...values });
	}
	window.zilpioFilterModels = (catalog, native) => {
		defaultModels = native.models;
		return filterModels(catalog, native, preferences);
	};
	function element(tag, text, className) {
		const node = document.createElement(tag); if (text) { node.textContent = text; } if (className) { node.className = className; } return node;
	}
	function checkbox(text, checked, change) {
		const label = element('label'), input = element('input'); input.type = 'checkbox'; input.checked = checked;
		input.addEventListener('change', () => change(input.checked)); label.append(input, document.createTextNode(text)); return { label, input };
	}
	function draw() {
		if (!list || !state?.catalog) { return; }
		list.replaceChildren();
		blacklistBody.replaceChildren();
		const countBlacklist = () => { blacklistSummary.textContent = `Blacklist (${blacklistBody.children.length})`; };
		for (const model of state.catalog) {
			const native = defaultModels.find(m => m.model === model.model);
			const choice = preferences?.models[model.model];
			const group = element('fieldset'); group.dataset.model = model.model;
			group.dataset.blacklisted = String(!!choice?.blacklisted);
			const legend = element('legend');
			const enabled = checkbox(model.displayName || model.model, choice ? choice.enabled : !!native, checked => {
				for (const input of group.querySelectorAll('.zilpio-model-efforts input')) { input.disabled = !checked; }
			});
			const remove = element('button', choice?.blacklisted ? 'Ripristina' : '×', 'zilpio-model-blacklist'); remove.type = 'button';
			remove.setAttribute('aria-label', `${choice?.blacklisted ? 'Ripristina' : 'Metti in blacklist'} ${model.displayName || model.model}`);
			remove.addEventListener('click', () => {
				const blocked = group.dataset.blacklisted !== 'true'; group.dataset.blacklisted = String(blocked);
				enabled.input.checked = !blocked;
				for (const input of group.querySelectorAll('.zilpio-model-efforts input')) { input.disabled = blocked; }
				remove.textContent = blocked ? 'Ripristina' : '×';
				remove.setAttribute('aria-label', `${blocked ? 'Ripristina' : 'Metti in blacklist'} ${model.displayName || model.model}`);
				(blocked ? blacklistBody : list).append(group); countBlacklist();
			});
			legend.append(enabled.label); group.append(legend, remove, element('small', model.model));
			const efforts = element('div', null, 'zilpio-model-efforts');
			for (const effort of model.supportedReasoningEfforts) {
				const item = checkbox(effort.reasoningEffort, choice ? choice.efforts.includes(effort.reasoningEffort) : native ? native.supportedReasoningEfforts.some(e => e.reasoningEffort === effort.reasoningEffort) : true, () => {});
				item.input.dataset.effort = effort.reasoningEffort; item.input.disabled = !enabled.input.checked; item.label.title = effort.description || ''; efforts.append(item.label);
			}
			group.append(efforts); (choice?.blacklisted ? blacklistBody : list).append(group);
		}
		countBlacklist();
		search.value = ''; status.textContent = `${state.catalog.length} modelli disponibili per l’account selezionato.`; save.disabled = false;
	}
	function open() {
		if (!dialog) {
			dialog = element('dialog', null, 'zilpio-model-settings'); dialog.setAttribute('aria-label', 'Modelli ed effort');
			const title = element('h2', 'Modelli ed effort'), close = element('button', 'Chiudi'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
			const header = element('header'); header.append(title, close);
			search = element('input'); search.type = 'search'; search.placeholder = 'Cerca modello…'; search.setAttribute('aria-label', 'Cerca modello');
			search.addEventListener('input', () => { for (const group of dialog.querySelectorAll('fieldset')) { group.hidden = !group.textContent.toLowerCase().includes(search.value.toLowerCase()); } });
			list = element('div', null, 'zilpio-model-list'); status = element('p'); status.setAttribute('role', 'status');
			blacklist = element('details', null, 'zilpio-model-blacklist-section'); blacklistSummary = element('summary', 'Blacklist (0)'); blacklistBody = element('div', null, 'zilpio-model-list'); blacklist.append(blacklistSummary, blacklistBody);
			const footer = element('footer'), all = element('button', 'Seleziona tutti'), refresh = element('button', 'Aggiorna catalogo');
			all.type = refresh.type = 'button';
			all.addEventListener('click', () => { for (const input of list.querySelectorAll('input')) { input.checked = true; input.disabled = false; } });
			refresh.addEventListener('click', () => { save.disabled = true; status.textContent = 'Caricamento…'; request('list', {}, true); });
			save = element('button', 'Salva'); save.type = 'button';
			save.addEventListener('click', () => {
				const models = Object.create(null);
				for (const group of dialog.querySelectorAll('fieldset')) {
					models[group.dataset.model] = { enabled: group.querySelector('legend input').checked, blacklisted: group.dataset.blacklisted === 'true', efforts: [...group.querySelectorAll('[data-effort]:checked')].map(input => input.dataset.effort) };
				}
				save.disabled = true; status.textContent = 'Salvataggio…'; request('save', { profileId: state?.profileId, models }, true);
			});
			footer.append(all, refresh, save); dialog.append(header, element('p', 'Puoi selezionare più modelli e più effort. La × sposta il modello nella blacklist; Salva applica le modifiche.'), search, list, blacklist, status, footer); document.body.append(dialog);
		}
		dialog.showModal(); blacklist.open = false; save.disabled = true; status.textContent = 'Caricamento…'; request('list', {}, true);
	}
	window.zilpioModels = {
		connect(value) { api = value; request('list'); },
		mount(account) {
			if (!button) { button = element('button', '⚙ Modelli', 'zilpio-model-settings-button'); button.type = 'button'; button.setAttribute('aria-label', 'Impostazioni modelli ed effort'); button.addEventListener('click', open); }
			if (account.nextElementSibling !== button) { account.insertAdjacentElement('afterend', button); }
		},
		accountChanged() { if (api) { request('list'); } }
	};
	window.addEventListener('message', ({ data }) => {
		if (data?.type !== 'zilpio-models-state') { return; }
		if (data.error) { if (status && data.requestId === dialogRequest) { status.textContent = data.error; save.disabled = !state?.catalog; } return; }
		state = data; preferences = data.preferences;
		window.zilpioModelsRevision = (window.zilpioModelsRevision || 0) + 1;
		window.zilpioRefreshModels?.();
		if (dialog?.open && data.requestId === dialogRequest) { if (data.saved) { dialog.close(); button.focus(); } else { draw(); } }
	});
})();
