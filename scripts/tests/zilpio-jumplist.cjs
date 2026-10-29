'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const engine = 'Z:\\ZSCode.Editor.exe';
const launcher = 'Z:\\ZSCode.exe';
let received;
const app = {
	setAppUserModelId() {}, on() {},
	whenReady: () => ({ then() {} }),
	setJumpList(categories) { received = categories; return 'ok'; }
};
const source = fs.readFileSync(path.join(__dirname, '../zilpio-main.cjs'), 'utf8').split("import('./out/main.js')")[0];
vm.runInNewContext(source, {
	require: name => name === 'electron' ? { app, shell: {} } : name === 'node:fs' ? { existsSync: () => true } : require(name),
	process: { platform: 'win32', execPath: engine, env: { ZILPIO_LAUNCHER: launcher, ZILPIO_APP_ICON: 'Z:\\icon.ico' } }
});
const folder = { type: 'task', program: engine, args: '--folder-uri "file:///C:/Project%20Name"', iconPath: 'explorer.exe' };
const workspace = { type: 'task', program: engine, args: '--file-uri "file:///C:/Project.code-workspace"' };
const newWindow = { type: 'task', program: engine, args: '-n', iconPath: engine };
const other = { type: 'task', program: 'other.exe', args: 'unchanged' };
assert.equal(app.setJumpList([{ type: 'custom', items: [folder, workspace] }, { type: 'tasks', items: [newWindow, other] }, { type: 'recent' }]), 'ok');
for (const [i, original] of [folder, workspace].entries()) {
	assert.equal(received[0].items[i].program, launcher);
	assert.equal(received[0].items[i].args, original.args);
}
assert.equal(received[0].items[0].iconPath, 'explorer.exe');
assert.equal(received[1].items[0].program, launcher);
assert.equal(received[1].items[0].iconPath, 'Z:\\icon.ico');
assert.equal(received[1].items[1], other);
assert.equal(folder.program, engine);
assert.equal(app.setJumpList(null), 'ok');
assert.equal(received, null);
console.log('PASS: recent folders/workspaces and New Window route through ZSCode; arguments and unrelated tasks preserved.');
