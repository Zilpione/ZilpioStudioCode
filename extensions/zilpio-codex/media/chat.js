/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
/* global acquireVsCodeApi */
'use strict';
const vscode = acquireVsCodeApi();
const messages = document.getElementById('messages');
const prompt = document.getElementById('prompt');
const items = new Map();
let busy = false;
let operation = false;
let profile;
let profileId;

function bubble(label, text, kind = '', id) {
	const section = document.createElement('section');
	section.className = `message ${kind}`;
	const heading = document.createElement('h3');
	heading.textContent = label;
	const content = document.createElement('pre');
	content.textContent = text;
	section.append(heading, content);
	messages.append(section);
	if (id) { items.set(id, content); }
	messages.scrollTop = messages.scrollHeight;
	return content;
}
function updateControls() {
	document.getElementById('send').disabled = busy || operation;
	for (const id of ['profile', 'login', 'new', 'history']) { document.getElementById(id).disabled = busy || operation; }
	document.getElementById('stop').hidden = !busy;
	document.getElementById('state').textContent = busy ? 'Codex sta lavorando…' : operation ? 'Operazione in corso…' : '';
}
function showItem(item, turnProfile) {
	if (items.has(item.id)) { return; }
	if (item.type === 'userMessage') { bubble('Tu', (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), '', item.id); }
	else if (item.type === 'agentMessage') { bubble(`Codex${turnProfile ? ` · ${turnProfile}` : ''}`, item.text || '', '', item.id); }
	else if (item.type === 'commandExecution') { bubble('Terminale', item.command || '', 'tool', item.id); }
	else if (item.type === 'fileChange') { bubble('File', (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n'), 'tool', item.id); }
	else if (item.type === 'mcpToolCall') { bubble('Strumento', `${item.server} · ${item.tool}`, 'tool', item.id); }
}
for (const id of ['profile', 'login', 'new', 'history', 'stop']) { document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id })); }
document.getElementById('composer').addEventListener('submit', event => {
	event.preventDefault();
	if (busy || operation || !prompt.value.trim()) { return; }
	const text = prompt.value.trim();
	prompt.value = '';
	bubble('Tu', text);
	vscode.postMessage({ type: 'send', text });
});
prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { document.getElementById('composer').requestSubmit(); } });
window.addEventListener('message', event => {
	const message = event.data;
	if (message.type === 'busy') { busy = message.busy; updateControls(); }
	else if (message.type === 'operation') { operation = message.busy; updateControls(); }
	else if (message.type === 'profile') {
		if (profileId && profileId !== message.id) { bubble('Profilo cambiato', `${profile || ''} → ${message.name}`, 'notice'); }
		profile = message.name;
		profileId = message.id;
		document.getElementById('profile').textContent = `Codex · ${profile} ▾`;
	} else if (message.type === 'error') { bubble('Errore', message.message, 'error'); }
	else if (message.type === 'clear') { messages.replaceChildren(); items.clear(); }
	else if (message.type === 'restore') {
		messages.replaceChildren(); items.clear();
		for (const turn of message.thread.turns || []) {
			const turnProfile = message.profiles?.find(p => p.turnId === turn.id)?.profileName;
			for (const item of turn.items || []) { showItem(item, turnProfile); if (item.type === 'commandExecution' && item.aggregatedOutput) { items.get(item.id).textContent += '\n' + item.aggregatedOutput; } }
		}
	} else if (message.type === 'event') {
		const { method, params } = message;
		if (method === 'item/started' && params.item.type !== 'userMessage') { showItem(params.item, profile); }
		else if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
			const node = items.get(params.itemId) || bubble(method.includes('agentMessage') ? `Codex · ${profile}` : 'Terminale', '', method.includes('agentMessage') ? '' : 'tool', params.itemId);
			node.textContent += params.delta;
			messages.scrollTop = messages.scrollHeight;
		} else if (method === 'item/completed') {
			if (params.item.type !== 'userMessage') { showItem(params.item, profile); }
			if (params.item.type === 'agentMessage') { items.get(params.item.id).textContent = params.item.text; }
		} else if (method === 'error') { bubble('Codex', params.error?.message || 'Errore del backend.', 'error'); }
		else if (method === 'turn/completed' && params.turn.error) { bubble('Codex', params.turn.error.message, 'error'); }
	}
});
vscode.postMessage({ type: 'ready' });
