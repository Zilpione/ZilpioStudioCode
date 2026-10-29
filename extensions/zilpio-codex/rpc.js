/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

class CodexRpc extends EventEmitter {
	constructor(child) {
		super();
		this.child = child;
		this.pending = new Map();
		this.nextId = 0;
		this.buffer = '';
		this.closed = false;
		this.exited = new Promise(resolve => child.once('close', resolve));
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', chunk => this.receive(chunk));
		// Drain stderr without logging account details or tokens.
		child.stderr.on('data', () => {});
		child.on('error', () => this.close('Codex process could not start. Check the binary path.'));
		child.on('exit', () => this.close('Codex connection closed. Reopen the chat to reconnect.'));
		child.stdin.on('error', () => this.close('Codex connection closed.'));
	}
	receive(chunk) {
		this.buffer += chunk;
		if (this.buffer.length > 32 * 1024 * 1024) { this.dispose(); return; }
		let newline;
		while ((newline = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) { continue; }
			let message;
			try { message = JSON.parse(line); } catch { this.close('Invalid Codex protocol response.'); return; }
			if (message.method && message.id !== undefined) {
				Promise.resolve().then(() => this.handleRequest?.(message.method, message.params)).then(result => {
					if (result === undefined) { this.write({ id: message.id, error: { code: -32601, message: 'Unsupported request' } }); }
					else { this.write({ id: message.id, result }); }
				}, () => this.write({ id: message.id, error: { code: -32000, message: 'Request could not be completed' } }));
			} else if (message.method) {
				this.emit('notification', message.method, message.params);
			} else {
				const pending = this.pending.get(message.id);
				if (!pending) { continue; }
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.error) { pending.reject(new Error(message.error.message || 'Codex request failed')); }
				else { pending.resolve(message.result); }
			}
		}
	}
	write(message) {
		if (!this.closed) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
	}
	request(method, params, timeout = 60000) {
		if (this.closed) { return Promise.reject(new Error('Codex connection closed.')); }
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			this.write({ id, method, params });
		});
	}
	async initialize() {
		const result = await this.request('initialize', { clientInfo: { name: 'zilpio_studio_code', title: 'ZilpioStudioCode', version: '0.1.0' }, capabilities: { experimentalApi: true } });
		this.write({ method: 'initialized' });
		return result;
	}
	close(reason) {
		if (this.closed) { return; }
		this.closed = true;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
		this.pending.clear();
		this.child.kill();
		this.emit('closed', reason);
	}
	dispose() { this.close('Codex connection closed.'); }
}

function startRpc(binary, home, ephemeral = false, overrides = []) {
	const env = { ...process.env, CODEX_HOME: home };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.OPENAI_API_KEY;
	delete env.OPENAI_BASE_URL;
	const args = ['app-server', '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false'];
	if (ephemeral) { args.push('-c', 'cli_auth_credentials_store="ephemeral"'); }
	args.push(...overrides);
	return new CodexRpc(spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
}
module.exports = { CodexRpc, startRpc };
