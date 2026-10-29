/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
(function () {
	'use strict';
	let api, agents = [], section, menu, dialog, suggestions, scheduled = false, signature, currentEditor;
	const pending = new Map();
	const chatActions = new Map();
	function element(tag, text, className) {
		const node = document.createElement(tag); if (text) { node.textContent = text; } if (className) { node.className = className; } return node;
	}
	function request(action, data = {}) {
		return new Promise((resolve, reject) => {
			const requestId = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Codex non ha risposto.')); }, 20000);
			pending.set(requestId, { resolve, reject, timer }); api.postMessage({ type: 'zilpio-agents', action, requestId, ...data });
		});
	}
	function error(message) {
		let status = document.querySelector('.zilpio-agents-status');
		if (!status) { status = element('div', null, 'zilpio-agents-status'); status.setAttribute('role', 'status'); document.body.append(status); }
		status.textContent = message; status.hidden = false; clearTimeout(status.hideTimer); status.hideTimer = setTimeout(() => { status.hidden = true; }, 8000);
	}
	function run(action, data) { return request(action, data).catch(e => error(e.message)); }
	function button(label, action) { const node = element('button', label); node.type = 'button'; node.addEventListener('click', action); return node; }
	function agentIcon(color) { const icon = element('span', null, 'zilpio-agent-icon'); icon.style.color = color; icon.setAttribute('aria-hidden', 'true'); return icon; }
	function openTab(threadId) { api?.postMessage({ type: 'navigate-in-new-editor-tab', path: `/local/${encodeURIComponent(threadId)}` }); }
	async function edit(threadId, agent) {
		menu?.hidePopover();
		if (dialog?.open) { return; }
		const node = element('dialog', null, 'zilpio-agent-dialog'); dialog = node;
		node.setAttribute('aria-label', agent ? 'Modifica ZilpioAgent' : 'Crea ZilpioAgent');
		const form = element('form'), heading = element('h2', agent ? 'Modifica ZilpioAgent' : 'Crea ZilpioAgent');
		const nameLabel = element('label', 'Nome'), name = element('input'); name.name = 'name'; name.maxLength = 40; name.required = true; name.autocomplete = 'off'; nameLabel.append(name);
		const colorLabel = element('label', 'Colore'), color = element('input'); color.type = 'color'; color.name = 'color'; color.value = agent?.color || '#8d9aff'; colorLabel.append(color);
		const status = element('p', 'Caricamento…'); status.setAttribute('role', 'status');
		const footer = element('footer'), cancel = button('Annulla', () => node.close()), save = element('button', 'Salva'); save.type = 'submit'; save.disabled = true;
		footer.append(cancel, save); form.append(heading, nameLabel, element('small', 'Il nome è univoco. Usa lettere, numeri, _ o -, senza spazi.'), colorLabel, status, footer); node.append(form); document.body.append(node);
		node.addEventListener('close', () => { node.remove(); if (dialog === node) { dialog = null; } }); node.showModal();
		form.addEventListener('submit', async event => {
			event.preventDefault(); save.disabled = true; status.textContent = 'Salvataggio…';
			try { await request(agent ? 'edit' : 'create', { threadId, id: agent?.id, name: name.value.trim(), color: color.value }); node.close(); }
			catch (e) { status.textContent = e.message; save.disabled = false; }
		});
		try {
			const values = agent || (await request('suggest')).suggestion;
			if (!node.open) { return; } name.value = values.name; color.value = values.color; status.textContent = ''; save.disabled = false; name.focus(); name.select();
		} catch (e) { status.textContent = e.message; }
	}
	function actions(agent, threadId) {
		const open = { id: 'zilpio-open-chat-tab', label: 'Apri in scheda', action: () => openTab(agent?.threadId || threadId) };
		return agent ? [
			...agent.available ? [open] : [],
			{ id: 'zilpio-edit-agent', label: 'Modifica agente', action: () => edit(agent.threadId, agent) },
			{ id: 'zilpio-delete-agent', label: 'Elimina agente', action: () => run('delete', { id: agent.id }) },
			...chatActions.get(agent.threadId)?.archive ? [{ id: 'zilpio-archive-chat', label: 'Archivia chat', action: () => chatActions.get(agent.threadId)?.archive() }] : []
		] : [open, { id: 'zilpio-create-agent', label: 'Crea ZilpioAgent', action: () => edit(threadId) }];
	}
	function showMenu(event, agent, threadId) {
		event.preventDefault(); event.stopPropagation();
		if (!menu) { menu = element('div', null, 'zilpio-agent-menu'); menu.popover = 'auto'; menu.setAttribute('role', 'menu'); document.body.append(menu); }
		menu.replaceChildren();
		for (const item of [...agent ? [{ label: 'Apri chat', action: () => run('open', { id: agent.id }) }] : [], ...actions(agent, threadId)]) {
			const entry = button(item.label, () => { menu.hidePopover(); item.action(); }); entry.setAttribute('role', 'menuitem'); menu.append(entry);
		}
		menu.style.left = `${Math.min(event.clientX, window.innerWidth - 210)}px`; menu.style.top = `${Math.min(event.clientY, window.innerHeight - 140)}px`; menu.showPopover(); menu.firstElementChild.focus();
	}
	function draw() {
		scheduled = false;
		const rows = [...document.querySelectorAll('[data-zilpio-thread]:not(.zilpio-agent-entry)')];
		for (const row of rows) {
			row.draggable = (row.dataset.zilpioHost || 'local') === 'local';
			const agent = agents.find(a => a.available && a.threadId === row.dataset.zilpioThread && (row.dataset.zilpioHost || 'local') === 'local');
			const title = row.querySelector('[data-thread-title]');
			if (agent) {
				if (row.dataset.zilpioAgentRow !== agent.id) { row.dataset.zilpioAgentRow = agent.id; }
				if (title && title.dataset.zilpioLabel !== agent.name) { title.dataset.zilpioLabel = agent.name; }
				if (title && title.style.getPropertyValue('--zilpio-agent-color') !== agent.color) { title.style.setProperty('--zilpio-agent-color', agent.color); }
			} else {
				if (row.hasAttribute('data-zilpio-agent-row')) { row.removeAttribute('data-zilpio-agent-row'); }
				if (title?.hasAttribute('data-zilpio-label')) { title.removeAttribute('data-zilpio-label'); title.style.removeProperty('--zilpio-agent-color'); }
			}
		}
		const first = rows.find(row => row.closest('[data-sidebar-project-kind]')) || rows[0];
		const navigation = first?.closest('nav,aside,[data-sidebar-root]');
		const docked = !navigation && !!document.querySelector('#root') && agents.length > 0;
		if (!first && !docked) { section?.remove(); document.body.classList.remove('zilpio-agents-docked'); signature = null; return; }
		const project = first?.closest('[data-sidebar-project-kind]');
		const parent = navigation || (docked ? document.body : project?.parentElement || first.parentElement);
		document.body.classList.toggle('zilpio-agents-docked', docked);
		if (!section) {
			section = element('details', null, 'zilpio-agents-section'); section.open = true;
			try { section.open = localStorage.getItem('zilpio-agents-collapsed') !== 'true'; } catch { /* Storage can be disabled in webviews. */ }
			section.addEventListener('toggle', () => { try { localStorage.setItem('zilpio-agents-collapsed', String(!section.open)); } catch { /* Optional preference. */ } });
			section.append(element('summary', 'ZilpioAgents'), element('div', null, 'zilpio-agents-list'));
		}
		if (section.parentElement !== parent) { parent.prepend(section); }
		const next = JSON.stringify(agents);
		if (signature === next) { return; } signature = next;
		const list = section.querySelector('.zilpio-agents-list'); list.replaceChildren();
		if (!agents.length) { list.append(element('p', 'Tasto destro su una chat → Crea ZilpioAgent', 'zilpio-agents-empty')); }
		for (const agent of agents) {
			const entry = button('', () => run('open', { id: agent.id })); entry.className = 'zilpio-agent-entry'; entry.dataset.agentId = agent.id;
			if (agent.available) { entry.dataset.zilpioThread = agent.threadId; entry.dataset.zilpioHost = 'local'; entry.draggable = true; }
			const state = !agent.available ? 'Altro environment' : agent.status === 'waiting' ? `In attesa di ${(agent.waitingFor || []).join(', ')}` : agent.status === 'working' ? 'Al lavoro' : 'Disponibile';
			entry.append(agentIcon(agent.color), element('span', agent.name), element('small', state));
			entry.title = `@${agent.name}${agent.originalTitle ? '\n' + agent.originalTitle : ''}`; entry.setAttribute('aria-label', `Apri agente ${agent.name}: ${state}`); entry.setAttribute('aria-disabled', String(!agent.available));
			entry.addEventListener('contextmenu', event => showMenu(event, agent));
			entry.addEventListener('keydown', event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { const rect = entry.getBoundingClientRect(); showMenu({ preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: rect.left, clientY: rect.bottom }, agent); } });
			list.append(entry);
		}
	}
	function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(draw); } }
	function editorText(editor) {
		if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) { return editor.value.slice(0, editor.selectionStart); }
		const selection = window.getSelection(); if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) { return ''; }
		const range = selection.getRangeAt(0).cloneRange(); range.selectNodeContents(editor); range.setEnd(selection.anchorNode, selection.anchorOffset); return range.toString();
	}
	function complete(editor, agent, match) {
		editor.focus();
		if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
			const end = editor.selectionStart; editor.setRangeText(`@${agent.name} `, end - match.length, end, 'end'); editor.dispatchEvent(new Event('input', { bubbles: true }));
		} else {
			// Use the editor's native input path so ProseMirror owns the document and undo history.
			const selection = window.getSelection();
			for (let i = 0; i < match.length; i++) { selection.modify('extend', 'backward', 'character'); }
			document.execCommand('insertText', false, `@${agent.name} `);
		}
		suggestions.hidden = true;
	}
	function suggest(editor) {
		const match = /(?:^|\s)(@[\p{L}\p{N}_-]*)$/u.exec(editorText(editor));
		const matches = match ? agents.filter(a => a.available && a.name.toLowerCase().startsWith(match[1].slice(1).toLowerCase())) : [];
		if (!suggestions) { suggestions = element('div', null, 'zilpio-agent-suggestions'); suggestions.setAttribute('role', 'listbox'); suggestions.setAttribute('aria-label', 'ZilpioAgents'); document.body.append(suggestions); }
		currentEditor = editor; suggestions.replaceChildren(); suggestions.hidden = !matches.length;
		if (!matches.length) { return; }
		const rect = editor.getBoundingClientRect(); suggestions.style.left = `${rect.left}px`; suggestions.style.bottom = `${window.innerHeight - rect.top + 6}px`;
		for (const agent of matches) {
			const entry = button(`@${agent.name}`, () => complete(editor, agent, match[1])); entry.prepend(agentIcon(agent.color)); entry.setAttribute('role', 'option');
			entry.addEventListener('mousedown', event => event.preventDefault()); suggestions.append(entry);
		}
	}
	window.zilpioAgents = {
		connect(value) { api = value; run('list'); },
		registerChat(threadId, hostId, archive) { if (!hostId || hostId === 'local') { chatActions.set(threadId, { archive }); } },
		context(event, threadId, hostId) {
			if (!hostId || hostId === 'local') { showMenu(event, agents.find(a => a.available && a.threadId === threadId), threadId); }
		},
		menu(threadId, hostId, items) {
			if (hostId && hostId !== 'local') { return items; }
			const agent = agents.find(a => a.available && a.threadId === threadId);
			return [...items, { id: 'zilpio-agent-separator', type: 'separator' }, ...actions(agent, threadId).map(a => ({ id: a.id, message: { id: a.id, defaultMessage: a.label }, onSelect: a.action }))];
		}
	};
	window.addEventListener('message', event => {
		const data = event.data;
		if (data?.type === 'zilpio-agents-error') { error(data.error); return; }
		if (data?.type !== 'zilpio-agents-state') { return; }
		if (data.agents) { agents = data.agents; schedule(); }
		const job = pending.get(data.requestId);
		if (job) { clearTimeout(job.timer); pending.delete(data.requestId); data.error ? job.reject(new Error(data.error)) : job.resolve(data); }
	});
	document.addEventListener('input', event => { const editor = event.target.closest?.('form[data-thread-find-composer] textarea,form[data-thread-find-composer] [contenteditable="true"],[contenteditable="true"][data-codex-composer="true"]'); if (editor) { suggest(editor); } });
	document.addEventListener('dragstart', event => {
		const row = event.target.closest?.('[data-zilpio-thread]');
		if (!row || !event.dataTransfer || (row.dataset.zilpioHost || 'local') !== 'local') { return; }
		const path = `/local/${row.dataset.zilpioThread}`;
		event.dataTransfer.effectAllowed = 'copyMove';
		event.dataTransfer.setData('CodeEditors', JSON.stringify([{ resource: { $mid: 1, scheme: 'openai-codex', authority: 'route', path }, options: { override: 'chatgpt.conversationEditor', pinned: true } }]));
		event.dataTransfer.setData('text/uri-list', `openai-codex://route/local/${encodeURIComponent(row.dataset.zilpioThread)}`);
		event.stopPropagation();
	}, true);
	document.addEventListener('keydown', event => {
		if (suggestions?.hidden === false && (event.target === currentEditor || suggestions.contains(event.target))) {
			if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); suggestions.hidden = true; }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); const entries = [...suggestions.children], index = entries.indexOf(document.activeElement), delta = event.key === 'ArrowDown' ? 1 : -1; entries[(index + delta + entries.length) % entries.length]?.focus(); }
			if (event.key === 'Tab' && event.target === currentEditor) { event.preventDefault(); event.stopImmediatePropagation(); suggestions.firstElementChild?.click(); }
		}
	}, true);
	document.addEventListener('focusin', event => { if (suggestions && event.target !== currentEditor && !suggestions.contains(event.target)) { suggestions.hidden = true; } });
	function observe() { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); schedule(); }
	if (document.body) { observe(); } else { document.addEventListener('DOMContentLoaded', observe, { once: true }); }
	setInterval(() => { if (api && !document.hidden) { run('list'); } }, 15000);
})();
