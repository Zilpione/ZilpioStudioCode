/* Local presentation layer for the bundled official Codex webview. */
(function () {
	'use strict';
	function windows(payload) {
		const bucket = payload?.rateLimitsByLimitId?.codex ?? payload?.rateLimits ?? payload;
		const result = { fiveHours: null, week: null };
		for (const window of [bucket?.primary, bucket?.secondary]) {
			if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) { continue; }
			const key = window.windowDurationMins === 300 ? 'fiveHours' : window.windowDurationMins === 10080 ? 'week' : null;
			if (!key) { continue; }
			const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
			result[key] = { remaining, resetsAt: window.resetsAt, color: remaining <= 20 ? 'red' : remaining <= 50 ? 'yellow' : 'green' };
		}
		return result;
	}
	function resetLabel(seconds, now = new Date()) {
		if (typeof seconds !== 'number' || !Number.isFinite(seconds)) { return 'reset non disponibile'; }
		const reset = new Date(seconds * 1000);
		if (!Number.isFinite(reset.getTime())) { return 'reset non disponibile'; }
		const time = reset.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false });
		const date = reset.toDateString() === now.toDateString() ? '' : ` (${reset.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })})`;
		return `reset alle ${time}${date}`;
	}
	if (typeof module === 'object' && module.exports) { module.exports = { windows, resetLabel }; return; }
	let api, pending, timeout, widget, rows, accountButton, accountMenu, accounts, modelCaption, nativeModel, fallbackFooter, fallbackRow, current = windows(null), scheduled = false;
	const acquire = window.acquireVsCodeApi;
	if (typeof acquire !== 'function') { return; }
	window.acquireVsCodeApi = function (...args) {
		api = acquire.apply(this, args);
		window.zilpioModels?.connect(api);
		window.zilpioEnvironments?.connect(api);
		window.zilpioAgents?.connect(api);
		window.acquireVsCodeApi = acquire;
		api.postMessage({ type: 'log-message', level: 'info', message: '[Zilpio controls] Bridge ready' });
		setTimeout(request, 2000);
		setTimeout(() => api.postMessage({ type: 'zilpio-profiles', action: 'list' }), 2000);
		return api;
	};
	function request() {
		if (!api || pending || document.hidden) { return; }
		pending = `zilpio-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		api.postMessage({ type: 'mcp-request', hostId: 'local', request: { id: pending, method: 'account/rateLimits/read', params: {} } });
		timeout = setTimeout(() => { pending = null; current = windows(null); render(); }, 15000);
	}
	function render() {
		if (!rows) { return; }
		for (const [key, row] of Object.entries(rows)) {
			const value = current[key];
			row.label.textContent = `${row.name} · ${resetLabel(value?.resetsAt)}`;
			row.value.textContent = value ? `${Math.round(value.remaining)}% rimanente` : 'Non disponibile';
			row.bar.style.width = value ? `${value.remaining}%` : '0%';
			row.bar.dataset.color = value?.color || 'unknown';
			row.track.setAttribute('aria-valuetext', row.value.textContent);
			if (value) { row.track.setAttribute('aria-valuenow', String(value.remaining)); } else { row.track.removeAttribute('aria-valuenow'); }
			row.track.title = typeof value?.resetsAt === 'number' ? `Ripristino: ${new Date(value.resetsAt * 1000).toLocaleString()}` : 'Quota dell’account attivo; nessuna stima';
		}
	}
	function chooseAccount(action, profileId) {
		accountMenu.hidePopover();
		accountButton.focus();
		accountButton.disabled = true;
		api.postMessage({ type: 'zilpio-profiles', action, profileId });
	}
	function openAccounts() {
		if (!api) { return; }
		if (accountMenu?.matches(':popover-open')) { accountMenu.hidePopover(); return; }
		if (!accountMenu) {
			accountMenu = document.createElement('div');
			accountMenu.id = 'zilpio-account-menu'; accountMenu.className = 'zilpio-account-menu'; accountMenu.popover = 'auto';
			accountMenu.setAttribute('role', 'menu'); accountMenu.setAttribute('aria-label', 'Account Codex');
			accountMenu.addEventListener('toggle', event => { accountButton.setAttribute('aria-expanded', String(event.newState === 'open')); });
			accountMenu.addEventListener('keydown', event => {
				const items = [...accountMenu.querySelectorAll('button')];
				const index = items.indexOf(document.activeElement);
				let next;
				if (event.key === 'ArrowDown') { next = (index + 1) % items.length; }
				if (event.key === 'ArrowUp') { next = (index - 1 + items.length) % items.length; }
				if (event.key === 'Home') { next = 0; }
				if (event.key === 'End') { next = items.length - 1; }
				if (next !== undefined) { event.preventDefault(); items[next].focus(); }
			});
			document.body.append(accountMenu);
		}
		accountMenu.replaceChildren();
		const add = (label, action, profileId, selected = false) => {
			const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
			item.setAttribute('role', profileId ? 'menuitemradio' : 'menuitem');
			if (profileId) { item.setAttribute('aria-checked', String(selected)); }
			item.addEventListener('click', () => chooseAccount(action, profileId)); accountMenu.append(item);
		};
		for (const profile of accounts?.profiles || []) { add(profile.name, 'select', profile.id, profile.id === accounts.activeProfileId); }
		const separator = document.createElement('hr'); separator.setAttribute('role', 'separator'); accountMenu.append(separator);
		add('＋ Nuovo ambiente…', 'new'); add('Modifica registro JSON', 'edit');
		const rect = accountButton.getBoundingClientRect();
		const above = rect.top >= window.innerHeight - rect.bottom;
		accountMenu.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
		accountMenu.style.maxHeight = `${Math.max(40, (above ? rect.top : window.innerHeight - rect.bottom) - 16)}px`;
		accountMenu.style.top = above ? 'auto' : `${rect.bottom + 6}px`;
		accountMenu.style.bottom = above ? `${window.innerHeight - rect.top + 6}px` : 'auto';
		accountMenu.showPopover();
		accountMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - accountMenu.offsetWidth - 8))}px`;
		(accountMenu.querySelector('[aria-checked="true"]') || accountMenu.querySelector('button')).focus();
	}
	window.addEventListener('resize', () => { if (accountMenu?.matches(':popover-open')) { accountMenu.hidePopover(); } });
	function visible(selector, root = document) {
		return [...root.querySelectorAll(selector)].find(node =>
			!node.closest('[hidden], [aria-hidden="true"]') &&
			node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
	}
	function decorate() {
		scheduled = false;
		// Codex retains old chat pages. Only decorate the currently visible composer.
		let composer = visible('[data-composer-surface-variant], form[data-thread-find-composer], form[data-chatgpt-composer]');
		const permissions = visible('[data-composer-navigation-target="permissions"]', composer || document) || visible('[data-composer-navigation-target="permissions"]');
		const model = visible('[data-composer-navigation-target="model"], [data-composer-navigation-target="reasoning"]', composer || document) || visible('[data-composer-navigation-target="model"], [data-composer-navigation-target="reasoning"]');
		nativeModel = model || [...document.querySelectorAll('[data-composer-navigation-target="model"], [data-composer-navigation-target="reasoning"]')].find(node => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
		if (permissions && !permissions.hasAttribute('data-zilpio-label')) {
			permissions.setAttribute('data-zilpio-label', 'Permessi');
			api?.postMessage({ type: 'log-message', level: 'info', message: '[Zilpio controls] Permissions labelled' });
		}
		if (model && !model.hasAttribute('data-zilpio-label')) {
			model.setAttribute('data-zilpio-label', 'Modello');
			api?.postMessage({ type: 'log-message', level: 'info', message: '[Zilpio controls] Model labelled' });
		}
		if (!modelCaption) {
			modelCaption = document.createElement('button'); modelCaption.type = 'button'; modelCaption.className = 'zilpio-current-model';
			modelCaption.addEventListener('click', () => nativeModel?.click());
		}
		const selection = window.zilpioActiveModel;
		const modelLabel = `Modello: ${selection?.model || 'Caricamento…'} · ${selection?.reasoningEffort || model?.dataset.selectedReasoningEffort || ''}`;
		if (modelCaption.textContent !== modelLabel) { modelCaption.textContent = modelLabel; }
		modelCaption.disabled = !nativeModel;
		const location = visible('[data-composer-navigation-target="run-location"]', composer || document);
		composer ||= (location || permissions || model)?.closest('[data-composer-surface-variant], form');
		if (!accountButton) {
			accountButton = document.createElement('button'); accountButton.type = 'button'; accountButton.className = 'zilpio-account-selector';
			accountButton.setAttribute('aria-label', 'Scegli account Codex');
			accountButton.setAttribute('aria-haspopup', 'menu'); accountButton.setAttribute('aria-expanded', 'false'); accountButton.setAttribute('aria-controls', 'zilpio-account-menu');
			accountButton.textContent = `Account: ${accounts?.profiles?.find(p => p.id === accounts.activeProfileId)?.name || 'Scegli'} ▾`;
			accountButton.addEventListener('click', openAccounts);
		}
		if (!location && !composer) { return; }
		if (!widget) {
			widget = document.createElement('section');
			widget.className = 'zilpio-usage';
			widget.setAttribute('aria-label', 'Quota Codex rimanente');
			rows = {};
			for (const [key, name] of [['fiveHours', '5 ore'], ['week', 'Settimana']]) {
				const row = document.createElement('div'), label = document.createElement('span'), value = document.createElement('span'), track = document.createElement('div'), bar = document.createElement('div');
				row.className = 'zilpio-usage-row'; label.textContent = name; value.className = 'zilpio-usage-value';
				track.className = 'zilpio-usage-track'; bar.className = 'zilpio-usage-fill';
				track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', `${name}: quota rimanente`); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
				track.append(bar); row.append(label, value, track); widget.append(row); rows[key] = { name, label, value, track, bar };
			}
			render();
		}
		// The home composer omits run-location. Keep the same controls below its input.
		let row;
		if (location) {
			if (location.nextElementSibling !== accountButton) { location.insertAdjacentElement('afterend', accountButton); }
			row = location.parentElement;
			if (fallbackFooter?.isConnected) { fallbackFooter.remove(); }
		} else {
			if (!fallbackFooter) {
				fallbackFooter = document.createElement('div'); fallbackFooter.className = 'zilpio-composer-footer';
				fallbackRow = document.createElement('div'); fallbackRow.className = 'zilpio-composer-account-row';
				fallbackFooter.append(fallbackRow);
			}
			if (fallbackFooter.parentElement !== composer) { composer.append(fallbackFooter); }
			if (accountButton.parentElement !== fallbackRow) { fallbackRow.append(accountButton); }
			row = fallbackRow;
		}
		if (row && row.nextElementSibling !== widget) {
			row.insertAdjacentElement('afterend', widget);
			api?.postMessage({ type: 'log-message', level: 'info', message: `[Zilpio controls] Bars mounted; permissions=${!!permissions}; model=${!!model}` });
		}
		if (modelCaption.parentElement !== row) { row.prepend(modelCaption); }
		window.zilpioModels?.mount(accountButton);
		window.zilpioEnvironments?.mount(accountButton.nextElementSibling?.classList.contains('zilpio-model-settings-button') ? accountButton.nextElementSibling : accountButton);
	}
	window.addEventListener('message', ({ data }) => {
		if (data?.type === 'zilpio-workspace-color' || data?.type === 'zilpio-profiles-state') {
			const color = data.type === 'zilpio-workspace-color' ? data.color : data.workspaceColor;
			if (typeof color === 'string' && /^#[a-fA-F0-9]{6}$/.test(color)) {
				document.documentElement.style.setProperty('--zilpio-workspace-color', color);
			} else { document.documentElement.style.removeProperty('--zilpio-workspace-color'); }
		}
		if (data?.type === 'zilpio-profiles-state') {
			accounts = data; const selected = data.profiles?.find(p => p.id === data.activeProfileId);
			window.zilpioModels?.accountChanged();
			if (accountButton) { accountButton.disabled = false; accountButton.textContent = `Account: ${selected?.name || 'Scegli'} ▾`; accountButton.title = data.error || 'Cambia account per il prossimo turno; la chat rimane aperta'; }
			request();
			api?.postMessage({ type: 'log-message', level: 'info', message: `[Zilpio controls] Account selector ready; profiles=${data.profiles?.length || 0}; authenticated=${!!selected}; error=${!!data.error}` });
		} else if (data?.type === 'mcp-response' && pending && String(data.message?.id) === pending) {
			clearTimeout(timeout); pending = null; current = windows(data.message.error ? null : data.message.result); render();
			api?.postMessage({ type: 'log-message', level: 'info', message: `[Zilpio controls] Usage response; fiveHours=${!!current.fiveHours}; week=${!!current.week}; error=${!!data.message.error}` });
		} else if (data?.type === 'mcp-notification' && data.method === 'account/rateLimits/updated') {
			current = windows(data.params); render();
		} else if (data?.type === 'mcp-notification' && data.method === 'account/updated') {
			clearTimeout(timeout); pending = null; current = windows(null); render(); request();
		}
	});
	function observe() {
		new MutationObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(decorate); } }).observe(document.body, {
			childList: true, subtree: true, attributes: true,
			attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-label', 'class', 'style', 'data-zilpio-model', 'data-selected-reasoning-effort']
		});
		decorate();
	}
	window.addEventListener('zilpio-model-changed', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(decorate); } });
	if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', observe, { once: true }); } else { observe(); }
	document.addEventListener('visibilitychange', () => { if (!document.hidden) { request(); } });
	setInterval(request, 60000);
})();
