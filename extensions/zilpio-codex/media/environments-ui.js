/* Local environment selector for the bundled official Codex webview. */
(function () {
	'use strict';
	let api, button, menu, state;
	function choose(action, environmentId) {
		menu.hidePopover(); button.focus(); button.disabled = true;
		api.postMessage({ type: 'zilpio-environments', action, environmentId });
	}
	function open() {
		if (!api) { return; }
		if (menu?.matches(':popover-open')) { menu.hidePopover(); return; }
		if (!menu) {
			menu = document.createElement('div'); menu.id = 'zilpio-environment-menu'; menu.className = 'zilpio-account-menu'; menu.popover = 'auto';
			menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Environment Codex');
			menu.addEventListener('toggle', event => button.setAttribute('aria-expanded', String(event.newState === 'open')));
			menu.addEventListener('keydown', event => {
				const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
				const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : undefined;
				if (next !== undefined) { event.preventDefault(); items[next].focus(); }
			});
			document.body.append(menu);
		}
		menu.replaceChildren();
		const add = (label, action, env) => {
			const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
			item.setAttribute('role', env ? 'menuitemradio' : 'menuitem');
			if (env) { item.setAttribute('aria-checked', String(env.id === state.activeEnvironmentId)); item.title = env.home; }
			item.addEventListener('click', () => choose(action, env?.id)); menu.append(item);
		};
		for (const env of state?.environments || []) { add(env.name, 'select', env); }
		const separator = document.createElement('hr'); separator.setAttribute('role', 'separator'); menu.append(separator);
		add('Nuovo environment…', 'new');
		add('Modifica impostazioni…', 'edit');
		const rect = button.getBoundingClientRect(), above = rect.top >= window.innerHeight - rect.bottom;
		menu.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
		menu.style.maxHeight = `${Math.max(40, (above ? rect.top : window.innerHeight - rect.bottom) - 16)}px`;
		menu.style.top = above ? 'auto' : `${rect.bottom + 6}px`; menu.style.bottom = above ? `${window.innerHeight - rect.top + 6}px` : 'auto';
		menu.showPopover(); menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
		(menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')).focus();
	}
	function render() {
		if (!button) { return; }
		const selected = state?.environments?.find(env => env.id === state.activeEnvironmentId);
		button.textContent = `Environment: ${selected?.name || 'Scegli'} ▾`;
		button.title = state?.error || (selected ? `${selected.home}\nCambia lo storico delle chat; la finestra si ricarica` : 'Scegli da dove caricare le chat');
		button.disabled = false;
	}
	window.zilpioEnvironments = {
		connect(value) { api = value; api.postMessage({ type: 'zilpio-environments', action: 'list' }); },
		mount(anchor) {
			if (!button) {
				button = document.createElement('button'); button.type = 'button'; button.className = 'zilpio-environment-selector';
				button.setAttribute('aria-label', 'Scegli environment delle chat'); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'zilpio-environment-menu');
				button.addEventListener('click', open); render();
			}
			if (anchor.nextElementSibling !== button) { anchor.insertAdjacentElement('afterend', button); }
		}
	};
	window.addEventListener('message', ({ data }) => {
		if (data?.type === 'zilpio-environments-state') { state = data; render(); }
		if (data?.type === 'zilpio-environments-reset' && api) {
			// Let the native new-chat navigation settle before clearing its saved route.
			requestAnimationFrame(() => requestAnimationFrame(() => {
				api.setState(undefined);
				api.postMessage({ type: 'zilpio-environments', action: 'reset-complete', requestId: data.requestId });
			}));
		}
	});
	window.addEventListener('resize', () => { if (menu?.matches(':popover-open')) { menu.hidePopover(); } });
})();
