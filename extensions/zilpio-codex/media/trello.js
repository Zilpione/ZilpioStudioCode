/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
(() => {
	'use strict';
	const api = acquireVsCodeApi(), state = window.trelloInitial, pending = new Map();
	const $ = id => document.getElementById(id), t = label => state.labels[label];
	let editing = !state.board, revision = 0, timer;
	for (const [id, label] of [['reload', 'Ricarica'], ['external', 'Apri nel Browser'], ['change', 'Impostazioni'], ['remove', 'Rimuovi Collegamento'], ['save', 'Salva'], ['cancel', 'Annulla'], ['url-label', 'Link della board Trello']]) { $(id).textContent = t(label); }
	$('project').textContent = state.name; $('project').title = state.folder;
	function render() {
		$('connect').hidden = !editing;
		$('native-trello').hidden = editing;
		for (const id of ['reload', 'external']) { $(id).disabled = !state.board || editing; }
		$('remove').hidden = !state.board;
		$('change').hidden = editing;
		$('cancel').hidden = !state.board;
		$('connect-title').textContent = t(state.board ? 'Cambia Board' : 'Collega Board Trello');
		$('connect-description').textContent = t('Incolla il link della board da associare al progetto.');
		$('notice').textContent = t(state.board ? 'Navigazione limitata alla board del progetto.' : 'Nessuna board collegata a questa cartella.');
		const host = $('native-trello');
		host.dataset.zilpioTrello = state.session;
		host.dataset.board = editing ? '' : state.board || '';
		host.dataset.revision = String(revision);
		host.dataset.loading = t('Caricamento Trello…');
		host.dataset.failed = t('Impossibile caricare Trello. Usa Ricarica per riprovare.');
		clearTimeout(timer);
		if (!editing) {
			$('trello-status').textContent = t('Caricamento Trello…');
			host.dataset.nativeReady = '';
			timer = setTimeout(() => { if (!host.dataset.nativeReady) { $('trello-status').textContent = t('Riavvia ZSCode per attivare la vista Trello integrata.'); } }, 10000);
		}
	}
	async function request(action, data = {}) {
		const requestId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(t('Riavvia ZSCode per attivare la vista Trello integrata.'))); }, 15000);
			pending.set(requestId, { resolve, reject, timeout }); api.postMessage({ action, ...data, requestId });
		});
	}
	window.addEventListener('message', ({ data }) => {
		const waiting = pending.get(data?.requestId); if (!waiting) { return; }
		pending.delete(data.requestId); clearTimeout(waiting.timeout);
		if (data.error) { waiting.reject(new Error(data.error)); } else { state.board = data.board; waiting.resolve(); }
	});
	const report = error => { $('error').textContent = error.message; $('notice').textContent = error.message; };
	$('board-form').addEventListener('submit', event => {
		event.preventDefault(); $('save').disabled = true; $('error').textContent = '';
		void request('save', { url: $('board-url').value }).then(() => { editing = false; revision++; render(); }).catch(report).finally(() => { $('save').disabled = false; });
	});
	$('change').addEventListener('click', () => { editing = true; $('board-url').value = state.board || ''; $('error').textContent = ''; render(); $('board-url').focus(); });
	$('cancel').addEventListener('click', () => { editing = false; render(); });
	$('remove').addEventListener('click', () => { void request('remove').then(() => { editing = true; $('board-url').value = ''; render(); }).catch(report); });
	$('reload').addEventListener('click', () => { revision++; render(); });
	$('external').addEventListener('click', () => { void request('external').catch(report); });
	render();
})();
