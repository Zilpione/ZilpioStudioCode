/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProfileStore, writeJson } = require('./profiles.js');
const { folderKey } = require('./workspaces.js');

function boardUrl(value) {
	let url;
	try { url = new URL(value.trim()); } catch { throw new Error('Incolla il link HTTPS di una board Trello: https://trello.com/b/…'); }
	const match = /^\/b\/([a-zA-Z0-9]{8})(?:\/[^?#]*)?$/.exec(url.pathname);
	if (url.protocol !== 'https:' || url.host !== 'trello.com' || url.username || url.password || !match) { throw new Error('Incolla il link HTTPS di una board Trello: https://trello.com/b/…'); }
	return `https://trello.com/b/${match[1]}`;
}

/** Shared navigation policy; card short links must come from the linked board's API. */
function navigation(value, board, cards = new Set()) {
	let url;
	try { url = new URL(value); } catch { return 'block'; }
	if (url.protocol !== 'https:' || url.username || url.password || url.port) { return 'block'; }
	if (url.hostname === 'trello.com') {
		if (/^\/(?:login|logout|signup|auth|authenticate|1\/(?:authentication|authorization|authorize|OAuthAuthorizeToken))(?:\/|$)/.test(url.pathname)) { return 'auth'; }
		const boardPath = new URL(board).pathname;
		if (url.pathname === boardPath + '.json' || url.pathname === boardPath + '.csv') { return 'download'; }
		const attachment = /^\/1\/cards\/([a-f0-9]{24})\/attachments\/[a-f0-9]{24}\/download(?:\/|$)/.exec(url.pathname);
		if (attachment && cards.has(attachment[1])) { return 'download'; }
		if (url.pathname === boardPath || url.pathname.startsWith(boardPath + '/')) { return 'allow'; }
		const card = /^\/c\/([a-zA-Z0-9]{8})(?:\/|$)/.exec(url.pathname);
		return card && cards.has(card[1]) ? 'allow' : 'block';
	}
	if (url.hostname === 'id.atlassian.com' || url.hostname === 'auth.atlassian.com' || url.hostname === 'accounts.google.com' || url.hostname === 'login.microsoftonline.com' || url.hostname === 'appleid.apple.com') { return 'auth'; }
	return 'external';
}

class TrelloStore extends ProfileStore {
	constructor(root) { super(root, [], { fileName: 'trello.json' }); }
	async load() {
		try {
			const db = JSON.parse(await fs.readFile(this.file, 'utf8'));
			if (db?.version !== 1 || !db.boards || typeof db.boards !== 'object' || Array.isArray(db.boards)) { throw new Error('Registro Trello non valido.'); }
			for (const [folder, url] of Object.entries(db.boards)) {
				if (!path.isAbsolute(folder) || boardUrl(url) !== url) { throw new Error('Associazione Trello non valida.'); }
			}
			return db;
		} catch (error) { if (error.code === 'ENOENT') { return { version: 1, boards: {} }; } throw error; }
	}
	async get(folder) { return (await this.load()).boards[folderKey(folder)]; }
	set(folder, value) {
		if (!folder || !path.isAbsolute(folder)) { return Promise.reject(new Error('Apri una cartella di lavoro prima di collegare Trello.')); }
		return this.serialize(async () => {
			const url = value === null ? null : boardUrl(value);
			const db = await this.load();
			if (url === null) { delete db.boards[folderKey(folder)]; } else { db.boards[folderKey(folder)] = url; }
			await writeJson(this.file, db);
			return url;
		});
	}
}
module.exports = { boardUrl, navigation, TrelloStore };
