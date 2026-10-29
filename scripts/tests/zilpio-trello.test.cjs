/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { boardUrl, navigation, TrelloStore } = require('../../extensions/zilpio-codex/trello.js');

test('accepts only full HTTPS Trello board URLs and removes tracking/slug', () => {
	assert.equal(boardUrl(' https://trello.com/b/AbCd1234/project?foo=bar#x '), 'https://trello.com/b/AbCd1234');
	for (const value of ['https://trello.com.evil/b/AbCd1234', 'http://trello.com/b/AbCd1234', 'https://user@trello.com/b/AbCd1234', 'https://trello.com:444/b/AbCd1234', 'https://trello.com/c/AbCd1234', 'javascript:alert(1)', 'https://trello.com/b/AbCd12345']) {
		assert.throws(() => boardUrl(value));
	}
});

test('locks navigation to board and its verified cards, allowing only authentication routes', () => {
	const board = 'https://trello.com/b/AbCd1234';
	const cards = new Set(['Card1234']);
	const urls = [board + '/slug', board + '?filter=member', 'https://trello.com/c/Card1234/card', 'https://trello.com/b/Other123', 'https://trello.com/c/Other123', 'https://trello.com/', 'https://trello.com/w/team', 'https://trello.com/login', 'https://id.atlassian.com/login', 'https://id.atlassian.com.evil/login', 'https://example.com/', 'file:///C:/secret', 'https://trello.com.evil/b/AbCd1234'];
	assert.deepEqual(urls.map(url => navigation(url, board, cards)), ['allow', 'allow', 'allow', 'block', 'block', 'block', 'block', 'auth', 'auth', 'external', 'external', 'block', 'external']);
});

test('downloads are limited to this board exports and attachments of its verified cards', () => {
	const board = 'https://trello.com/b/AbCd1234', cards = new Set(['123456789012345678901234']);
	assert.deepEqual([
		'https://trello.com/b/AbCd1234.json',
		'https://trello.com/b/Other123.csv',
		'https://trello.com/1/cards/123456789012345678901234/attachments/012345678901234567890123/download/file.pdf',
		'https://trello.com/1/cards/000000000000000000000000/attachments/012345678901234567890123/download/file.pdf'
	].map(url => navigation(url, board, cards)), ['download', 'block', 'download', 'block']);
});

test('folder association persists across instances, normalizes paths and can be removed', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-trello-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const store = new TrelloStore(root);
	const folder = path.join(root, 'project');
	assert.equal(await store.get(folder), undefined);
	await store.set(folder, 'https://trello.com/b/AbCd1234/name');
	assert.deepEqual([await new TrelloStore(root).get(path.join(folder, '.')), await store.get(path.join(root, 'other'))], ['https://trello.com/b/AbCd1234', undefined]);
	if (process.platform === 'win32') { assert.equal(await store.get(folder.toUpperCase()), 'https://trello.com/b/AbCd1234'); }
	await assert.rejects(store.set(folder, 'https://example.com/'));
	assert.equal(await store.get(folder), 'https://trello.com/b/AbCd1234');
	await store.set(folder, null);
	assert.equal(await store.get(folder), undefined);
});

test('invalid registry is reported rather than silently overwritten', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zilpio-trello-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.writeFile(path.join(root, 'trello.json'), '{bad');
	await assert.rejects(new TrelloStore(root).get(root));
	assert.equal(await fs.readFile(path.join(root, 'trello.json'), 'utf8'), '{bad');
});
