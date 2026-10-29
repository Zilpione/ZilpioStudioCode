/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
(() => {
	'use strict';
	const api = acquireVsCodeApi();
	const pending = new Map(), quotas = new Map();
	let state, editing, changing = false, refreshing = false, listing = false;
	const $ = id => document.getElementById(id);
	const trello = document.createElement('button');
	trello.textContent = 'Trello'; trello.type = 'button';
	trello.addEventListener('click', () => { void request('trello').catch(showError); });
	document.querySelector('main > header').append(trello);
	function request(action, data = {}) {
		const requestId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Operazione scaduta. Riprova.')); }, 90000);
			pending.set(requestId, { resolve, reject, timer });
			api.postMessage({ action, ...data, requestId });
		});
	}
	window.addEventListener('message', ({ data }) => {
		const waiter = pending.get(data?.requestId);
		if (!waiter) { return; }
		pending.delete(data.requestId); clearTimeout(waiter.timer);
		if (data.error) { waiter.reject(new Error(data.error)); } else { waiter.resolve(data.result); }
	});
	function node(tag, className, text) {
		const element = document.createElement(tag);
		if (className) { element.className = className; }
		if (text !== undefined) { element.textContent = text; }
		return element;
	}
	function button(label, action, className) {
		const element = node('button', className, label); element.type = 'button';
		element.addEventListener('click', () => { void Promise.resolve().then(action).catch(showError); });
		return element;
	}
	function showError(error) { $('notice').hidden = false; $('notice').textContent = error.message; }
	function updateResetCountdowns() {
		for (const countdown of document.querySelectorAll('.reset-countdown[data-resets-at]')) {
			const minutes = Math.max(0, Math.ceil((Number(countdown.dataset.resetsAt) * 1000 - Date.now()) / 60000));
			countdown.textContent = `${Math.floor(minutes / 60)}h e ${minutes % 60} m`;
		}
	}
	function iconButton(label, action, paths) {
		const element = button('', action, 'icon-button');
		element.setAttribute('aria-label', label); element.title = label;
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
		for (const data of paths) {
			const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', data); svg.append(path);
		}
		element.append(svg); return element;
	}
	async function load() {
		if (listing || changing) { return; }
		listing = true;
		try {
			const next = await request('list');
			const changed = JSON.stringify(state) !== JSON.stringify(next);
			state = next;
			if (changed) { render(); }
		}
		finally { listing = false; }
	}
	async function refreshUsage() {
		if (!state || refreshing || document.hidden) { return; }
		refreshing = true; $('refresh').disabled = true;
		try {
			await Promise.all([...new Set(state.usageCards.map(card => card.accountId))].map(async accountId => {
				try { quotas.set(accountId, { windows: await request('usage', { accountId }), at: Date.now() }); }
				catch (error) { quotas.set(accountId, { error: error.message }); }
			}));
			render();
		} finally { refreshing = false; $('refresh').disabled = false; }
	}
	function render() {
		if (!state) { return; }
		const busy = state.busy || changing;
		$('notice').hidden = !busy && !state.error;
		$('notice').textContent = changing || state.switching ? 'Cambio workspace o account in corso…' : busy ? 'Codex sta lavorando in questa finestra. Potrai cambiare workspace quando avrà terminato.' : state.error || '';
		for (const kind of ['workspaces', 'usageCards']) {
			const grid = $(kind); grid.replaceChildren();
			for (const card of state[kind]) {
				const active = kind === 'workspaces' && state.activeId === card.id;
				const article = node('article', `card ${kind === 'usageCards' ? 'usage-card' : 'workspace-card'}${active ? ' active' : ''}`);
				article.style.setProperty('--card-color', card.color);
				const heading = node('div', 'card-header');
				const title = node('div', 'card-title');
				title.append(node('h3', '', card.name));
				const account = state.profiles.find(p => p.id === card.accountId)?.name || 'Account non disponibile';
				if (active) { title.append(node('span', 'badge', '● Attivo')); }
				const tools = node('div', 'card-tools');
				tools.append(iconButton(`Modifica ${card.name}`, () => edit(kind, card), ['M15 5l4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z']), iconButton(`Elimina ${card.name}`, async () => { await request('delete', { kind, id: card.id }); await load(); }, ['M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7']));
				heading.append(title, tools);
				article.append(heading);
				if (kind === 'workspaces') {
					article.append(node('p', 'folder', card.folder));
					const details = node('dl', 'details');
					details.append(node('dt', '', 'Account'), node('dd', '', account), node('dt', '', 'Environment'), node('dd', '', state.environments.find(p => p.id === card.environmentId)?.name || 'Non disponibile'));
					article.append(details);
				} else {
					const usage = quotas.get(card.accountId);
					const fiveHourWindow = usage?.windows?.find(window => window.windowDurationMins === 300);
					if (Number.isFinite(fiveHourWindow?.resetsAt)) {
						const resetDate = new Date(fiveHourWindow.resetsAt * 1000);
						const reset = node('span', 'reset-time', resetDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
						reset.title = `Reset delle 5 ore: ${resetDate.toLocaleString('it-IT')}`;
						title.append(reset);
					}
					if (!usage?.windows?.length) { article.append(node('p', 'subtitle', usage?.error || (usage ? 'Quote non disponibili per questo account.' : 'Caricamento consumi…'))); }
					for (const window of usage?.windows || []) {
						const row = node('div', 'quota'), label = node('div', 'quota-label');
						const duration = window.windowDurationMins;
						const name = duration === 300 ? '5 ore' : duration === 10080 ? 'Settimana' : `${duration ?? '?'} minuti`;
						const remaining = 100 - window.usedPercent;
						const countdown = node('span', 'reset-countdown');
						if (Number.isFinite(window.resetsAt)) {
							countdown.dataset.resetsAt = String(window.resetsAt);
							countdown.title = `Reset: ${new Date(window.resetsAt * 1000).toLocaleString('it-IT')}`;
						}
						label.append(node('span', '', name), countdown, node('strong', '', `${Math.round(remaining)}% disponibile`));
						const track = node('div', 'bar-wrap'), background = node('div', 'track'), fill = node('div', 'fill');
						track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', `${name}: quota disponibile`); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', String(remaining));
						fill.dataset.level = remaining <= 20 ? 'low' : remaining <= 50 ? 'medium' : 'high';
						fill.style.width = `${remaining}%`; track.append(background, fill); row.append(label, track);
						article.append(row);
					}
					if (usage?.at) { article.append(node('p', 'reset', `Aggiornato alle ${new Date(usage.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`)); }
				}
				const actions = node('div', 'card-actions');
				if (kind === 'workspaces') {
					const openCard = async action => {
						changing = true; render();
						try { await request(action, { id: card.id }); changing = false; await load(); render(); }
						catch (error) { changing = false; render(); throw error; }
					};
					const folder = button('Apri Cartella', () => openCard('openFolder'), 'open-folder');
					const workspace = button('Apri Workspace', () => openCard('select'), 'open-workspace');
					folder.disabled = workspace.disabled = busy;
					actions.append(folder, workspace);
				}
				if (kind === 'workspaces') { article.append(actions); }
				grid.append(article);
			}
			if (!state[kind].length) { grid.append(node('div', 'empty', kind === 'workspaces' ? 'Aggiungi il tuo primo workspace: cartella, account ed environment in un clic.' : 'Aggiungi gli account di cui vuoi vedere i consumi.')); }
		}
		updateResetCountdowns();
	}
	function edit(kind, card) {
		if (!state) { return; }
		editing = { kind, id: card?.id || crypto.randomUUID() };
		$('form-title').textContent = `${card ? 'Modifica' : 'Aggiungi'} ${kind === 'workspaces' ? 'Workspace' : 'Consumo Account'}`;
		$('name').value = card?.name || ''; $('folder').value = card?.folder || ''; $('color').value = card?.color || '#7c8aff';
		$('folder-field').hidden = $('environment-field').hidden = kind !== 'workspaces';
		for (const [id, entries, selected] of [['account', state.profiles, card?.accountId], ['environment', state.environments, card?.environmentId]]) {
			$(id).replaceChildren();
			for (const entry of entries) { const option = node('option', '', entry.name); option.value = entry.id; $(id).append(option); }
			if (selected) { $(id).value = selected; }
		}
		$('environment').required = kind === 'workspaces'; $('form-error').textContent = '';
		$('edit-dialog').showModal(); $('name').focus();
	}
	$('browse').addEventListener('click', () => { void request('browse').then(folder => { if (folder) { $('folder').value = folder; } }).catch(error => { $('form-error').textContent = error.message; }); });
	$('cancel').addEventListener('click', () => $('edit-dialog').close());
	$('edit-form').addEventListener('submit', event => {
		event.preventDefault();
		void (async () => {
			const card = { id: editing.id, name: $('name').value.trim(), accountId: $('account').value, color: $('color').value };
			if (editing.kind === 'workspaces') { card.folder = $('folder').value; card.environmentId = $('environment').value; }
			await request('save', { kind: editing.kind, card }); $('edit-dialog').close(); await load(); await refreshUsage();
		})().catch(error => { $('form-error').textContent = error.message; });
	});
	$('add-workspace').addEventListener('click', () => edit('workspaces'));
	$('add-usage').addEventListener('click', () => edit('usageCards'));
	$('refresh').addEventListener('click', () => { void load().then(refreshUsage).catch(showError); });
	void load().then(refreshUsage).catch(showError);
	setInterval(() => { if (!document.hidden && !changing) { void load().catch(showError); } }, 3000);
	setInterval(() => { updateResetCountdowns(); void refreshUsage().catch(showError); }, 60000);
	document.addEventListener('visibilitychange', () => { if (!document.hidden) { void load().then(refreshUsage).catch(showError); } });
})();
