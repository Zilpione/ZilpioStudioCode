const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('registers the Codex toolbar command and renders the volume panel', async () => {
  const commands = new Map();
  const copiedFiles = [];
  const configurationUpdates = [];
  const telegramRequests = [];
  const savedSettings = new Map();
  const errorMessages = [];
  const executedCommands = [];
  let runtimeEnabled = false;
  let createdPanel;
  let registeredView;
  let loadedExtension;
  const disposable = { dispose() {} };
  const statusBar = {
    hide() {},
    show() {},
    dispose() {},
    text: '',
    tooltip: '',
    command: ''
  };
  const output = { appendLine() {}, dispose() {} };
  const vscodeMock = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor {
      constructor(id) { this.id = id; }
    },
    ViewColumn: { Active: -1 },
    Uri: {
      joinPath(base, ...parts) {
        const fsPath = [base.fsPath, ...parts].join('\\');
        return { fsPath, toString() { return fsPath; } };
      },
      file(fsPath) {
        return { fsPath, toString() { return fsPath; } };
      }
    },
    commands: {
      registerCommand(id, callback) {
        commands.set(id, callback);
        return disposable;
      },
      executeCommand(...args) {
        executedCommands.push(args);
        return Promise.resolve();
      }
    },
    window: {
      state: { focused: true },
      createOutputChannel() { return output; },
      createStatusBarItem() { return statusBar; },
      registerWebviewViewProvider(id, provider, options) {
        registeredView = { id, provider, options };
        return disposable;
      },
      createWebviewPanel(viewType, title, column, options) {
        const webview = {
          html: '',
          onDidReceiveMessage(callback) { this.receive = callback; return disposable; },
          postMessage() { return Promise.resolve(true); }
        };
        createdPanel = {
          viewType,
          title,
          column,
          options,
          webview,
          onDidDispose() { return disposable; },
          reveal() {}
        };
        return createdPanel;
      },
      onDidStartTerminalShellExecution() { return disposable; },
      onDidEndTerminalShellExecution() { return disposable; },
      onDidChangeActiveTextEditor() { return disposable; },
      onDidChangeTextEditorSelection() { return disposable; },
      onDidChangeTextEditorVisibleRanges() { return disposable; },
      onDidChangeActiveTerminal() { return disposable; },
      showInformationMessage() { return Promise.resolve(); },
      showErrorMessage(message) { errorMessages.push(message); return Promise.resolve(); },
      showOpenDialog() {
        return Promise.resolve([{ fsPath: 'C:\\sounds\\done.mp3', toString() { return this.fsPath; } }]);
      }
    },
    workspace: {
      workspaceFolders: [{ name: 'workspace', uri: { fsPath: 'C:\\workspace' } }],
      fs: {
        createDirectory() { return Promise.resolve(); },
        copy(source, target, options) {
          copiedFiles.push({ source, target, options });
          return Promise.resolve();
        },
        delete() { return Promise.resolve(); }
      },
      getConfiguration() {
        return {
          get(key, fallback) {
            if (savedSettings.has(key)) return savedSettings.get(key);
            if (key === 'enabled') return runtimeEnabled;
            if (key === 'playSound' || key === 'taskbarFlash' || key === 'stopOnInteraction') return false;
            return fallback;
          },
          inspect() { return {}; },
          update(key, value, target) {
            configurationUpdates.push({ key, value, target });
            savedSettings.set(key, value);
            if (key === 'workbench.colorCustomizations' && target === 2) {
              return Promise.reject(new Error('workspace settings unavailable'));
            }
            return Promise.resolve();
          }
        };
      },
      onDidChangeTextDocument() { return disposable; },
      onDidChangeConfiguration() { return disposable; }
    }
  };

  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    telegramRequests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extensionPath = require.resolve('../dist/extension.js');
    delete require.cache[extensionPath];
    loadedExtension = require(extensionPath);
    loadedExtension.activate({
      extension: { id: 'zilpio.codex-notifier-telegram' },
      extensionUri: { fsPath: 'C:\\extension' },
      globalStorageUri: { fsPath: 'C:\\storage' },
      logUri: { fsPath: 'C:\\logs\\window\\exthost' },
      subscriptions: []
    });

    const openPanel = commands.get('codexNotifierTelegram.openSettingsPanel');
    assert.equal(typeof openPanel, 'function');
    await openPanel();
    assert.equal(createdPanel.viewType, 'codexNotifierTelegram.settingsPanel');
    assert.match(createdPanel.webview.html, /type="range"/);
    assert.match(createdPanel.webview.html, /Upload custom sound/);
    assert.match(createdPanel.webview.html, /Reset to default sound/);
    assert.match(createdPanel.webview.html, /All settings/);
    await createdPanel.webview.receive({ type: 'openSettings' });
    assert.deepEqual(executedCommands.at(-1), [
      'workbench.action.openSettings', '@ext:zilpio.codex-notifier-telegram'
    ]);
    assert.match(createdPanel.webview.html, /id="telegramBotToken" type="password"/);
    await createdPanel.webview.receive({ type: 'saveTelegram', enabled: true, botToken: ' 123456:fake_token ', chatId: ' -100123456789 ' });
    assert.equal(savedSettings.get('telegram.enabled'), true);
    assert.equal(savedSettings.get('telegram.botToken'), '123456:fake_token');
    assert.equal(savedSettings.get('telegram.chatId'), '-100123456789');
    assert.ok(configurationUpdates.filter((entry) => entry.key.startsWith('telegram.')).every((entry) => entry.target === 1));
    // Explicit test works even with the main notifier disabled.
    await createdPanel.webview.receive({ type: 'testTelegram', botToken: '123456:fake_token', chatId: '-100123456789' });
    assert.equal(telegramRequests.length, 1);
    assert.equal(telegramRequests[0].body.chat_id, '-100123456789');
    await commands.get('codexNotifierTelegram.notifyDone')();
    assert.equal(telegramRequests.length, 1);
    assert.equal(registeredView.id, 'codexNotifierTelegram.settingsView');
    assert.equal(registeredView.options.webviewOptions.retainContextWhenHidden, true);
    const sidebarWebview = {
      html: '',
      options: {},
      onDidReceiveMessage() { return disposable; },
      postMessage() { return Promise.resolve(true); }
    };
    registeredView.provider.resolveWebviewView({
      webview: sidebarWebview,
      onDidDispose() { return disposable; }
    });
    assert.equal(sidebarWebview.options.enableScripts, true);
    assert.match(sidebarWebview.html, /Notification sound/);
    assert.match(sidebarWebview.html, /type="range"/);

    const selectSound = commands.get('codexNotifierTelegram.selectSound');
    assert.equal(typeof selectSound, 'function');
    await selectSound();
    assert.equal(copiedFiles.length, 1);
    assert.equal(copiedFiles[0].source.fsPath, 'C:\\sounds\\done.mp3');
    assert.equal(copiedFiles[0].target.fsPath, 'C:\\storage\\sounds\\done.mp3');
    assert.deepEqual(copiedFiles[0].options, { overwrite: true });
    assert.ok(configurationUpdates.some((update) =>
      update.key === 'soundPath' && update.value === 'C:\\storage\\sounds\\done.mp3'
    ));

    const manifest = require('../package.json');
    assert.equal(manifest.contributes.menus['editor/title'][0].when, 'resourceScheme == openai-codex');
    assert.match(manifest.contributes.menus['view/title'][0].when, /chatgpt\.sidebarView/);
    assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'codexNotifierTelegram');
    assert.equal(manifest.contributes.views.codexNotifierTelegram[0].id, 'codexNotifierTelegram.settingsView');
    assert.equal(manifest.contributes.views.codexNotifierTelegram[0].type, 'webview');
    assert.equal(manifest.contributes.configuration.properties['codexNotifierTelegram.soundPath'].scope, 'machine');

    runtimeEnabled = true;
    const testAlert = commands.get('codexNotifierTelegram.testAlert');
    assert.equal(typeof testAlert, 'function');
    await testAlert();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(telegramRequests.length, 2);
    assert.match(telegramRequests[1].body.text, /Codex/);
    await commands.get('codexNotifierTelegram.notifyDone')();
    assert.equal(telegramRequests.length, 2, 'active alert suppresses duplicate Telegram notifications');
    const colorUpdate = configurationUpdates.findLast((update) => update.key === 'workbench.colorCustomizations');
    assert.ok(configurationUpdates.some((update) =>
      update.key === 'workbench.colorCustomizations' && update.target === 2
    ));
    assert.equal(colorUpdate.target, 1);
    assert.equal(colorUpdate.value['statusBarItem.warningBackground'], '#2EB872');
    assert.equal(colorUpdate.value['statusBarItem.warningForeground'], '#EAFFF2');
    assert.equal('statusBar.background' in colorUpdate.value, false);
    assert.equal(statusBar.text, '       >>>>> CODEX IS DONE <<<<<       ');
    assert.equal(statusBar.backgroundColor.id, 'statusBarItem.warningBackground');
    assert.equal(statusBar.color, undefined);
    assert.equal(statusBar.name, 'Codex completion alert');
    assert.equal(statusBar.accessibilityInformation.label, 'Codex completion alert');
    commands.get('codexNotifierTelegram.dismissAlert')();
    savedSettings.set('telegram.enabled', false);
    await testAlert();
    assert.equal(telegramRequests.length, 2, 'Telegram toggle disables automatic sending');
    commands.get('codexNotifierTelegram.dismissAlert')();
    savedSettings.set('telegram.enabled', true);
    globalThis.fetch = async () => { throw new Error('123456:fake_token'); };
    await testAlert();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(statusBar.text, /CODEX IS DONE/);
    await createdPanel.webview.receive({ type: 'testTelegram', botToken: '123456:fake_token', chatId: '-100123456789' });
    assert.ok(errorMessages.some((message) => /Telegram/.test(message)));
    assert.ok(errorMessages.every((message) => !message.includes('123456:fake_token')));
  } finally {
    loadedExtension?.deactivate();
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});
