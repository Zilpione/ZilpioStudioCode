/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('editor drags entering another webview reach the native split drop target', () => {
	const source = fs.readFileSync(path.join(__dirname, '../../src/vs/workbench/contrib/webview/browser/pre/index.html'), 'utf8');
	const start = source.indexOf('function handleInnerEditorDragStartEvent('), end = source.indexOf('function handleInnerDragEvent(', start);
	const messages = [];
	const handle = vm.runInNewContext(`${source.slice(start, end)};handleInnerEditorDragStartEvent`, { hostMessaging: { postMessage: type => messages.push(type) } });
	for (const types of [['codeeditors'], ['text/plain'], ['text/uri-list']]) {
		handle({ defaultPrevented: false, shiftKey: false, dataTransfer: { types, items: [{ kind: 'string' }] } });
	}
	assert.deepEqual(messages, ['drag-start']);
	handle({ defaultPrevented: true, shiftKey: false, dataTransfer: { types: ['codeeditors'], items: [{ kind: 'string' }] } });
	assert.deepEqual(messages, ['drag-start', 'drag-start']);
	handle({ defaultPrevented: false, shiftKey: true, dataTransfer: { types: ['codeeditors'], items: [{ kind: 'string' }] } });
	assert.deepEqual(messages, ['drag-start', 'drag-start'], 'Shift must preserve the inner webview file drop behavior');
});

test('webview bootstrap remains allowed by its content security policy', () => {
	const source = fs.readFileSync(path.join(__dirname, '../../src/vs/workbench/contrib/webview/browser/pre/index.html'), 'utf8');
	const script = source.match(/<script async type="module">([\s\S]*?)<\/script>/)[1].replace(/\r\n/g, '\n');
	const hash = require('node:crypto').createHash('sha256').update(script).digest('base64');
	assert.equal(source.match(/script-src 'sha256-([^']+)'/)[1], hash);
});
