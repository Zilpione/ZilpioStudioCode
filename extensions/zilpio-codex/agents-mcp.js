/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';
const readline = require('node:readline');
const http = require('node:http');
function call(endpoint, key, input) {
	return new Promise((resolve, reject) => {
		const request = http.request(endpoint, { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' } }, response => {
			let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; if (body.length > 1048576) { request.destroy(new Error('Risposta troppo grande.')); } });
			response.on('end', () => { try { const result = JSON.parse(body); if (response.statusCode !== 200 || result.error) { reject(new Error(result.error || 'Collegamento agenti non disponibile.')); } else { resolve(result); } } catch (error) { reject(error); } });
		});
		request.on('error', reject); request.end(JSON.stringify(input));
	});
}
async function handle(message, endpoint, key) {
	if (message.method === 'initialize') { return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ZilpioAgents', version: '1.0.1' }, instructions: 'ZilpioAgents are existing chat conversations, not subagents. Before delegating to @Name or claiming it is unavailable, call list_agents. Use send_message with its stable ID to start work in that exact chat with its existing context. Never spawn a replacement subagent for a named ZilpioAgent, even when a skill suggests spawning. list_agents returns only this project and environment, including self when this chat is an agent. send_message waits until the recipient finishes and returns the final result directly. Keep your turn open while it runs, then use that result to answer the user. Never poll, sleep, resend or forward a duplicate answer.' }; }
	if (message.method === 'ping') { return {}; }
	if (message.method === 'tools/list') { return { tools: [
		{ name: 'list_agents', description: 'Resolve existing ZilpioAgents in this project/environment by name or stable ID. Returns self for the current agent. Always use this before delegating to a named agent or reporting it missing; these agents are not in collaboration.list_agents.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
		{ name: 'send_message', description: 'Delegate a task to an existing ZilpioAgent by stable ID, Name or @Name. The task runs in its actual chat, retaining its history and permissions. This call waits for the recipient to finish, then returns the final result directly; keep the current turn open and use the result to answer the user. Busy recipients queue requests. Never substitute spawn_agent, followup_task or a new subagent for this tool. Use only for user-requested delegation or authorized coordination. Do not poll, resend or forward a duplicate answer.', inputSchema: { type: 'object', properties: { recipient: { type: 'string' }, message: { type: 'string' } }, required: ['recipient', 'message'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }
	] }; }
	if (message.method === 'tools/call') {
		try {
			if (!['list_agents', 'send_message'].includes(message.params?.name)) { throw new Error('Tool sconosciuto.'); }
			const value = await call(endpoint, key, { ...message.params.arguments, action: message.params.name === 'list_agents' ? 'list' : 'send' });
			return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
		} catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
	}
	throw new Error('Metodo MCP non supportato.');
}
if (require.main === module) {
	const [endpoint, key] = process.argv.slice(2);
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint || '') || !key) { process.exitCode = 1; }
	else {
		const lines = readline.createInterface({ input: process.stdin });
		lines.on('line', async line => {
			let message;
			try { message = JSON.parse(line); if (message.id === undefined) { return; } const result = await handle(message, endpoint, key); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'); }
			catch (error) { if (message?.id !== undefined) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }) + '\n'); } }
		});
	}
}
module.exports = { handle };
