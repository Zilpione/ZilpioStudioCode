import * as vscode from 'vscode';
import { type ChildProcess, spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveSoundPath, volumeToMpg123Scale, volumeToUnitInterval } from './sound.js';
import { OpenAiCodexLogDetector, type OpenAiCodexDetectionMode } from './codex-log-detector.js';
import { sendTelegramMessage } from './telegram.js';

type FlashMode = 'editorOverlay' | 'workbenchColors' | 'off';

interface NotifierConfig {
  enabled: boolean;
  playSound: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  soundVolume: number;
  soundPath: string;
  flashMode: FlashMode;
  stopOnInteraction: boolean;
  flashIntervalMs: number;
  maxFlashSeconds: number;
  terminalCommandPattern: string;
  detectTerminalCodex: boolean;
  detectCodexProcess: boolean;
  detectOpenAiCodexLog: boolean;
  openAiCodexDetectionMode: OpenAiCodexDetectionMode;
  processPollIntervalMs: number;
  notifyWhenWindowFocused: boolean;
  taskbarFlash: boolean;
  workbenchColorTarget: 'workspace' | 'global';
}

const configSection = 'codexNotifierTelegram';

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let activeExecutions = new WeakSet<vscode.TerminalShellExecution>();
let extensionUri: vscode.Uri;
let extensionId: string;
let customSoundStorageUri: vscode.Uri;
let flashTimer: NodeJS.Timeout | undefined;
let maxFlashTimer: NodeJS.Timeout | undefined;
let inputWatcher: ChildProcess | undefined;
let activeSoundProcess: ChildProcess | undefined;
let taskbarFlashing = false;
let isPulseOn = false;
let alertActive = false;
let ignoreInteractionUntil = 0;
let workbenchRestore: WorkbenchRestore | undefined;
let pulseGeneration = 0;
let workbenchUpdateQueue: Thenable<void> = Promise.resolve();
let pulseStep = 0;
let processPollTimer: NodeJS.Timeout | undefined;
let knownCodexProcessIds = new Set<number>();
let processMonitorInitialized = false;
let processPolling = false;
let processMonitorStarted = false;
let openAiCodexLogPath: string | undefined;
let openAiCodexLogOffset = 0;
let openAiCodexLogInitialized = false;
let openAiCodexLogPolling = false;
let openAiCodexLogDetector: OpenAiCodexLogDetector;
let lastCompletionAlertAt = 0;
const completionDedupeWindowMs = 2500;
const interactionGraceMs = 1500;

interface WorkbenchRestore {
  readonly target: vscode.ConfigurationTarget;
  readonly originalValue: Record<string, unknown> | undefined;
  readonly originalEffectiveValue: Record<string, unknown> | undefined;
}

export function activate(context: vscode.ExtensionContext) {
  extensionId = context.extension.id;
  extensionUri = context.extensionUri;
  customSoundStorageUri = vscode.Uri.joinPath(context.globalStorageUri, 'sounds');
  openAiCodexLogPath = path.join(path.dirname(context.logUri.fsPath), 'openai.chatgpt', 'Codex.log');
  output = vscode.window.createOutputChannel('Zilpio Codex Notifier');
  openAiCodexLogDetector = new OpenAiCodexLogDetector((source) => void notifyDone(source));
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.name = 'Codex completion alert';
  statusBar.command = 'codexNotifierTelegram.dismissAlert';
  statusBar.tooltip = 'Zilpio Codex Notifier';
  statusBar.accessibilityInformation = { label: 'Codex completion alert' };
  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('codexNotifierTelegram.openSettingsPanel', () => NotifierSettingsPanel.show()),
    vscode.commands.registerCommand('codexNotifierTelegram.notifyDone', () => notifyDone('manual command')),
    vscode.commands.registerCommand('codexNotifierTelegram.testAlert', () => notifyDone('test command')),
    vscode.commands.registerCommand('codexNotifierTelegram.selectSound', selectCustomSound),
    vscode.commands.registerCommand('codexNotifierTelegram.dismissAlert', () => stopAlert()),
    vscode.commands.registerCommand('codexNotifierTelegram.markStarted', () => markStarted('manual command')),
    vscode.window.registerWebviewViewProvider(
      'codexNotifierTelegram.settingsView',
      new NotifierSettingsViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('type', onTypeCommand),
    vscode.window.onDidStartTerminalShellExecution(onTerminalExecutionStarted),
    vscode.window.onDidEndTerminalShellExecution(onTerminalExecutionEnded),
    vscode.window.onDidChangeActiveTextEditor(() => dismissOnInteraction('active editor changed')),
    vscode.window.onDidChangeTextEditorSelection(onTextEditorSelectionChanged),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => dismissOnInteraction('editor scrolled')),
    vscode.window.onDidChangeActiveTerminal(() => dismissOnInteraction('active terminal changed')),
    vscode.workspace.onDidChangeTextDocument(onTextDocumentChanged),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(configSection)) {
        NotifierSettingsPanel.refreshActive();
        NotifierSettingsViewProvider.refreshActive();
        refreshStatus();
        restartProcessMonitor();
        if (alertActive) {
          restartFlash();
        }
      }
    }),
    { dispose: () => {
      stopProcessMonitor();
      openAiCodexLogDetector.dispose();
      stopAlert();
      stopSound();
    } }
  );

  refreshStatus();
  restartProcessMonitor();
  output.appendLine('Zilpio Codex Notifier activated.');
}

export function deactivate() {
  openAiCodexLogDetector?.dispose();
  stopAlert();
  stopSound();
}

function getConfig(): NotifierConfig {
  const cfg = vscode.workspace.getConfiguration(configSection);
  return {
    enabled: cfg.get('enabled', true),
    playSound: cfg.get('playSound', true),
    telegramEnabled: cfg.get('telegram.enabled', false),
    telegramBotToken: cfg.get('telegram.botToken', ''),
    telegramChatId: cfg.get('telegram.chatId', ''),
    soundVolume: clamp(cfg.get('soundVolume', 50), 0, 100),
    soundPath: cfg.get('soundPath', ''),
    flashMode: cfg.get<FlashMode>('flashMode', 'workbenchColors'),
    stopOnInteraction: cfg.get('stopOnInteraction', true),
    flashIntervalMs: clamp(cfg.get('flashIntervalMs', 900), 500, 3000),
    maxFlashSeconds: clamp(cfg.get('maxFlashSeconds', 0), 0, 600),
    terminalCommandPattern: cfg.get(
      'terminalCommandPattern',
      '(^|\\b)(codex|npx\\s+codex|pnpm\\s+codex|npm\\s+exec\\s+codex)(\\b|\\s)'
    ),
    detectTerminalCodex: cfg.get('detectTerminalCodex', true),
    detectCodexProcess: cfg.get('detectCodexProcess', false),
    detectOpenAiCodexLog: cfg.get('detectOpenAiCodexLog', true),
    openAiCodexDetectionMode: cfg.get<OpenAiCodexDetectionMode>('openAiCodexDetectionMode', 'chatHeuristic'),
    processPollIntervalMs: clamp(cfg.get('processPollIntervalMs', 500), 500, 10000),
    notifyWhenWindowFocused: cfg.get('notifyWhenWindowFocused', true),
    taskbarFlash: cfg.get('taskbarFlash', true),
    workbenchColorTarget: cfg.get<'workspace' | 'global'>('workbenchColorTarget', 'workspace')
  };
}

function restartProcessMonitor() {
  stopProcessMonitor();

  const cfg = getConfig();
  if (!cfg.enabled || (!cfg.detectCodexProcess && !cfg.detectOpenAiCodexLog)) {
    knownCodexProcessIds = new Set();
    processMonitorInitialized = false;
    processMonitorStarted = false;
    openAiCodexLogOffset = 0;
    openAiCodexLogInitialized = false;
    openAiCodexLogDetector.reset();
    return;
  }

  if (!cfg.detectCodexProcess) {
    knownCodexProcessIds = new Set();
    processMonitorInitialized = false;
    processMonitorStarted = false;
  }

  void pollCodexProcesses();
  processPollTimer = setInterval(() => void pollCodexProcesses(), cfg.processPollIntervalMs);
}

function stopProcessMonitor() {
  if (processPollTimer) {
    clearInterval(processPollTimer);
    processPollTimer = undefined;
  }
}

async function pollCodexProcesses() {
  if (processPolling) {
    return;
  }

  processPolling = true;
  try {
    const cfg = getConfig();
    const processes = cfg.detectCodexProcess ? await listCodexProcesses() : [];
    if (cfg.detectOpenAiCodexLog) {
      await pollOpenAiCodexLog();
    }
    if (!cfg.detectCodexProcess) {
      knownCodexProcessIds = new Set();
      processMonitorInitialized = true;
      processMonitorStarted = false;
      return;
    }

    const currentIds = new Set(processes.map((process) => process.pid));
    const hadProcesses = knownCodexProcessIds.size > 0;
    const hasProcesses = currentIds.size > 0;

    if (!processMonitorInitialized) {
      knownCodexProcessIds = currentIds;
      processMonitorStarted = hasProcesses;
      processMonitorInitialized = true;
      return;
    }

    if (hasProcesses && !hadProcesses) {
      markStarted(`process: ${processes.map((process) => process.label).join(', ')}`);
    } else if (!hasProcesses && hadProcesses && processMonitorStarted) {
      void notifyDone('Codex process ended');
    }

    if (hasProcesses) {
      processMonitorStarted = true;
    }
    knownCodexProcessIds = currentIds;
  } catch (error) {
    output.appendLine(`Unable to poll Codex processes: ${String(error)}`);
  } finally {
    processPolling = false;
  }
}

async function pollOpenAiCodexLog() {
  if (!openAiCodexLogPath || openAiCodexLogPolling) {
    return;
  }

  openAiCodexLogPolling = true;
  try {
    const stat = await fs.stat(openAiCodexLogPath);
    if (!openAiCodexLogInitialized || stat.size < openAiCodexLogOffset) {
      openAiCodexLogOffset = stat.size;
      openAiCodexLogInitialized = true;
      return;
    }

    if (stat.size === openAiCodexLogOffset) {
      return;
    }

    const content = await fs.readFile(openAiCodexLogPath);
    const chunk = content.subarray(openAiCodexLogOffset).toString('utf8');
    openAiCodexLogOffset = stat.size;
    openAiCodexLogDetector.inspect(chunk, getConfig().openAiCodexDetectionMode);
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') {
      output.appendLine(`Unable to read OpenAI Codex log: ${String(error)}`);
    }
  } finally {
    openAiCodexLogPolling = false;
  }
}

interface CodexProcess {
  readonly pid: number;
  readonly label: string;
}

function listCodexProcesses(): Promise<CodexProcess[]> {
  if (process.platform === 'win32') {
    return listWindowsCodexProcesses();
  }

  return listUnixCodexProcesses();
}

function listWindowsCodexProcesses(): Promise<CodexProcess[]> {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Get-CimInstance Win32_Process -Filter "Name = \'codex.exe\'" |',
    'Where-Object { $_.ExecutablePath -like "*\\openai.chatgpt-*\\bin\\*" -or $_.CommandLine -match "(^|[\\\\/\\s])codex(\\.exe)?([\\s`"]|$)" } |',
    'ForEach-Object { $label = $_.ExecutablePath; if (-not $label) { $label = $_.Name }; "{0}|{1}" -f $_.ProcessId, $label }'
  ].join('\n');

  return execFileLines('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ]).then((lines) => parseProcessLines(lines));
}

function listUnixCodexProcesses(): Promise<CodexProcess[]> {
  return execFileLines('ps', ['-eo', 'pid=,comm=,args=']).then((lines) => {
    return lines.flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) {
        return [];
      }

      const pid = Number.parseInt(match[1], 10);
      const command = match[2];
      const args = match[3];
      if (!Number.isFinite(pid) || pid === process.pid) {
        return [];
      }

      if (!/(^|[\\/])codex(?:$|[.\s])|^codex$/i.test(command) && !/(^|[\\/])codex(?:$|[.\s])/i.test(args)) {
        return [];
      }

      return [{ pid, label: command }];
    });
  });
}

function execFileLines(command: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 256 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

function parseProcessLines(lines: string[]): CodexProcess[] {
  return lines.flatMap((line) => {
    const [pidValue, label = 'codex'] = line.split('|', 2);
    const pid = Number.parseInt(pidValue, 10);
    if (!Number.isFinite(pid)) {
      return [];
    }

    return [{ pid, label }];
  });
}

function onTypeCommand(args: unknown) {
  dismissOnInteraction('keyboard input');
  return vscode.commands.executeCommand('default:type', args);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function onTerminalExecutionStarted(event: vscode.TerminalShellExecutionStartEvent) {
  dismissOnInteraction('terminal command started');

  const cfg = getConfig();
  if (!cfg.enabled || !cfg.detectTerminalCodex) {
    return;
  }

  const commandLine = event.execution.commandLine.value;
  if (matchesCodexCommand(commandLine, cfg.terminalCommandPattern)) {
    activeExecutions.add(event.execution);
    markStarted(`terminal: ${commandLine}`);
  }
}

function onTerminalExecutionEnded(event: vscode.TerminalShellExecutionEndEvent) {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.detectTerminalCodex) {
    return;
  }

  const commandLine = event.execution.commandLine.value;
  const startedAsCodex = activeExecutions.has(event.execution);
  const endedAsCodex = matchesCodexCommand(commandLine, cfg.terminalCommandPattern);

  if (startedAsCodex || endedAsCodex) {
    notifyDone(`terminal exit ${event.exitCode ?? 'unknown'}: ${commandLine}`);
  }
}

function onTextEditorSelectionChanged(event: vscode.TextEditorSelectionChangeEvent) {
  dismissOnInteraction(event.kind === undefined ? 'editor selection changed' : 'mouse or keyboard selection');
}

function onTextDocumentChanged(event: vscode.TextDocumentChangeEvent) {
  if (!isSettingsDocument(event.document)) {
    dismissOnInteraction('document changed');
  }
}

function isSettingsDocument(document: vscode.TextDocument): boolean {
  return /(?:^|[\\/])(?:settings|tasks|launch)\.json$/i.test(document.uri.fsPath);
}

function matchesCodexCommand(commandLine: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(commandLine);
  } catch (error) {
    output.appendLine(`Invalid terminalCommandPattern: ${String(error)}`);
    return /\bcodex\b/i.test(commandLine);
  }
}

function markStarted(source: string) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return;
  }

  stopAlert();
  clearNativeStatusPulse();
  statusBar.text = '$(sync~spin) Codex working';
  statusBar.tooltip = `Codex work detected from ${source}. Run "Zilpio Codex Notifier: Notify Codex Done" if this was started manually.`;
  statusBar.show();
  output.appendLine(`Codex work started from ${source}.`);
}

async function notifyDone(source: string) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return;
  }

  const now = Date.now();
  const manualRequest = source === 'manual command' || source === 'test command';
  if (alertActive || (!manualRequest && now - lastCompletionAlertAt < completionDedupeWindowMs)) {
    output.appendLine(`Ignored duplicate completion from ${source}.`);
    return;
  }
  lastCompletionAlertAt = now;

  output.appendLine(`Codex completion detected from ${source}.`);
  setAlertStatusFrame(0);
  statusBar.tooltip = 'Codex work finished. Click to dismiss the alert.';
  statusBar.show();

  if (cfg.telegramEnabled) {
    void sendTelegramMessage(
      { botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId },
      '✅ Codex ha terminato il task.'
    ).catch((error: Error) => output.appendLine(error.message));
  }

  if (cfg.playSound && cfg.soundVolume > 0) {
    playGentleSound(cfg);
  }

  if (cfg.taskbarFlash) {
    flashTaskbar(true);
  }

  await startFlash();

  if (cfg.notifyWhenWindowFocused || !vscode.window.state.focused) {
    void vscode.window
      .showInformationMessage('Codex finished working.', 'Dismiss')
      .then((choice) => {
        if (choice === 'Dismiss') {
          stopAlert();
        }
      });
  }
}

async function selectCustomSound() {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Use Notification Sound',
    filters: {
      'Audio files': ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']
    }
  });

  const source = selected?.[0];
  if (!source) {
    return;
  }

  const extension = path.extname(source.fsPath).toLowerCase();
  const supportedExtensions = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
  if (!supportedExtensions.has(extension)) {
    void vscode.window.showErrorMessage('Choose an MP3, WAV, M4A, AAC, OGG, or FLAC audio file.');
    return;
  }

  const previousPath = getConfig().soundPath;
  const target = vscode.Uri.joinPath(customSoundStorageUri, path.basename(source.fsPath));
  await vscode.workspace.fs.createDirectory(customSoundStorageUri);
  if (source.toString() !== target.toString()) {
    await vscode.workspace.fs.copy(source, target, { overwrite: true });
  }
  await vscode.workspace
    .getConfiguration(configSection)
    .update('soundPath', target.fsPath, vscode.ConfigurationTarget.Global);
  await deleteManagedSound(previousPath, target.fsPath);
  void vscode.window.showInformationMessage('Custom sound imported. You can now move or delete the original file.');
}

async function resetCustomSound(): Promise<void> {
  const previousPath = getConfig().soundPath;
  await updateSettingsConfig('soundPath', '');
  await deleteManagedSound(previousPath);
}

async function deleteManagedSound(candidatePath: string, exceptPath?: string): Promise<void> {
  if (!candidatePath || candidatePath === exceptPath || !isManagedSoundPath(candidatePath)) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(candidatePath));
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (code !== 'FileNotFound' && code !== 'ENOENT') {
      output.appendLine(`Unable to remove the previous imported sound: ${String(error)}`);
    }
  }
}

function isManagedSoundPath(candidatePath: string): boolean {
  const relative = path.relative(customSoundStorageUri.fsPath, candidatePath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

class NotifierSettingsPanel {
  private static current: NotifierSettingsPanel | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = NotifierSettingsPanel.getHtml();
    panel.webview.onDidReceiveMessage((message: unknown) => NotifierSettingsPanel.handleMessage(message));
    panel.onDidDispose(() => {
      if (NotifierSettingsPanel.current === this) {
        NotifierSettingsPanel.current = undefined;
      }
    });
  }

  static show(): void {
    if (NotifierSettingsPanel.current) {
      NotifierSettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      NotifierSettingsPanel.current.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'codexNotifierTelegram.settingsPanel',
      'Zilpio Codex Notifier Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    NotifierSettingsPanel.current = new NotifierSettingsPanel(panel);
  }

  static refreshActive(): void {
    NotifierSettingsPanel.current?.refresh();
  }

  private refresh(): void {
    void this.panel.webview.postMessage({ type: 'config', config: NotifierSettingsPanel.getViewConfig() });
  }

  static async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }

    const type = String(message.type);
    try {
      if (type === 'setEnabled' && 'value' in message && typeof message.value === 'boolean') {
        await updateSettingsConfig('enabled', message.value);
      } else if (type === 'setPlaySound' && 'value' in message && typeof message.value === 'boolean') {
        await updateSettingsConfig('playSound', message.value);
      } else if (type === 'setVolume' && 'value' in message) {
        const volume = Number(message.value);
        if (Number.isFinite(volume)) {
          await updateSettingsConfig('soundVolume', Math.round(clamp(volume, 0, 100)));
        }
      } else if (type === 'selectSound') {
        await selectCustomSound();
      } else if (type === 'resetSound') {
        await resetCustomSound();
      } else if (type === 'testAlert') {
        await notifyDone('test command');
      } else if (type === 'saveTelegram' &&
        'enabled' in message && typeof message.enabled === 'boolean' &&
        'botToken' in message && typeof message.botToken === 'string' &&
        'chatId' in message && typeof message.chatId === 'string') {
        // Disable first so an in-flight completion cannot use partially updated credentials.
        await updateSettingsConfig('telegram.enabled', false);
        await updateSettingsConfig('telegram.botToken', message.botToken.trim());
        await updateSettingsConfig('telegram.chatId', message.chatId.trim());
        await updateSettingsConfig('telegram.enabled', message.enabled);
        void vscode.window.showInformationMessage('Telegram settings saved.');
      } else if (type === 'testTelegram' &&
        'botToken' in message && typeof message.botToken === 'string' &&
        'chatId' in message && typeof message.chatId === 'string') {
        await sendTelegramMessage(
          { botToken: message.botToken, chatId: message.chatId },
          '✅ Messaggio di prova da Zilpio Codex Notifier.'
        );
        void vscode.window.showInformationMessage('Telegram test message sent.');
      } else if (type === 'openSettings') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          `@ext:${extensionId}`
        );
      }
    } catch (error) {
      if (type === 'saveTelegram' || type === 'testTelegram') {
        const detail = type === 'testTelegram' && error instanceof Error
          ? error.message : 'Unable to save Telegram settings. Check that your global settings file is writable.';
        output.appendLine(detail);
        void vscode.window.showErrorMessage(detail);
        return;
      }
      output.appendLine(`Unable to update notifier settings panel: ${String(error)}`);
      void vscode.window.showErrorMessage(`Unable to update Zilpio Codex Notifier settings: ${String(error)}`);
    }
  }

  static getViewConfig() {
    const cfg = getConfig();
    return {
      enabled: cfg.enabled,
      playSound: cfg.playSound,
      telegramEnabled: cfg.telegramEnabled,
      telegramBotToken: cfg.telegramBotToken,
      telegramChatId: cfg.telegramChatId,
      soundVolume: Math.round(cfg.soundVolume),
      soundPath: cfg.soundPath,
      soundName: cfg.soundPath ? path.basename(cfg.soundPath) : 'Bundled notification'
    };
  }

  static getHtml(): string {
    const cfg = NotifierSettingsPanel.getViewConfig();
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      padding: 14px 16px 24px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    h2 { margin: 0 0 16px; font-size: 15px; font-weight: 600; }
    .section { margin-bottom: 20px; }
    .toggle { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
    .toggle input { margin: 0; }
    .label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 7px; }
    .volume-value { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    input[type='range'] { width: 100%; accent-color: var(--vscode-focusBorder); }
    .telegram-field { display: block; margin: 10px 0 4px; }
    input[type='text'], input[type='password'] {
      box-sizing: border-box; width: 100%; padding: 6px 8px; margin-bottom: 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
    }
    .sound-name {
      padding: 8px 10px;
      margin: 7px 0 9px;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .button-row { display: flex; flex-wrap: wrap; gap: 7px; }
    button {
      padding: 5px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    button:disabled:hover { background: var(--vscode-button-secondaryBackground); }
    button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .hint { margin-top: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <h2>Completion alerts</h2>
  <div class="section">
    <label class="toggle"><input id="enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> Enable notifier</label>
    <label class="toggle"><input id="playSound" type="checkbox" ${cfg.playSound ? 'checked' : ''}> Play sound</label>
  </div>
  <div class="section">
    <div class="label-row"><label for="volume">Volume</label><span id="volumeValue" class="volume-value">${cfg.soundVolume}%</span></div>
    <input id="volume" type="range" min="0" max="100" step="1" value="${cfg.soundVolume}" aria-label="Notification volume">
  </div>
  <div class="section">
    <label>Notification sound</label>
    <div id="soundName" class="sound-name" title="${escapeHtml(cfg.soundPath)}">${escapeHtml(cfg.soundName)}</div>
    <div class="button-row">
      <button id="selectSound">Upload custom sound</button>
      <button id="resetSound" class="secondary" ${cfg.soundPath ? '' : 'disabled'}>Reset to default sound</button>
    </div>
  </div>
  <div class="section">
    <h2>Telegram</h2>
    <label class="toggle"><input id="telegramEnabled" type="checkbox" ${cfg.telegramEnabled ? 'checked' : ''}> Enable Telegram notifications</label>
    <label class="telegram-field" for="telegramBotToken">Bot token</label>
    <input id="telegramBotToken" type="password" value="${escapeHtml(cfg.telegramBotToken)}" autocomplete="off" spellcheck="false" placeholder="Token from BotFather">
    <label class="telegram-field" for="telegramChatId">Chat ID</label>
    <input id="telegramChatId" type="text" value="${escapeHtml(cfg.telegramChatId)}" autocomplete="off" spellcheck="false" placeholder="123456789 or -100123456789">
    <div class="button-row">
      <button id="saveTelegram">Save Telegram settings</button>
      <button id="testTelegram" class="secondary">Send test message</button>
    </div>
    <p class="hint">Start a chat with your bot first. The token is stored in plain text in your global settings.json. The test uses the fields above without saving them; save to apply automatic notifications.</p>
  </div>
  <div class="button-row">
    <button id="testAlert">Test alert</button>
    <button id="openSettings" class="secondary">All settings</button>
  </div>
  <p class="hint">Changes are saved to your global VS Code settings.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const enabled = document.getElementById('enabled');
    const playSound = document.getElementById('playSound');
    const volume = document.getElementById('volume');
    const volumeValue = document.getElementById('volumeValue');
    const soundName = document.getElementById('soundName');
    const resetSound = document.getElementById('resetSound');
    const telegramEnabled = document.getElementById('telegramEnabled');
    const telegramBotToken = document.getElementById('telegramBotToken');
    const telegramChatId = document.getElementById('telegramChatId');
    let telegramDirty = false;
    for (const field of [telegramEnabled, telegramBotToken, telegramChatId]) {
      field.addEventListener('input', () => { telegramDirty = true; });
    }
    document.getElementById('saveTelegram').addEventListener('click', () => {
      vscode.postMessage({ type: 'saveTelegram', enabled: telegramEnabled.checked,
        botToken: telegramBotToken.value, chatId: telegramChatId.value });
      telegramDirty = false;
    });
    document.getElementById('testTelegram').addEventListener('click', () => {
      vscode.postMessage({ type: 'testTelegram', botToken: telegramBotToken.value, chatId: telegramChatId.value });
    });

    enabled.addEventListener('change', () => vscode.postMessage({ type: 'setEnabled', value: enabled.checked }));
    playSound.addEventListener('change', () => vscode.postMessage({ type: 'setPlaySound', value: playSound.checked }));
    volume.addEventListener('input', () => { volumeValue.textContent = volume.value + '%'; });
    volume.addEventListener('change', () => vscode.postMessage({ type: 'setVolume', value: Number(volume.value) }));
    document.getElementById('selectSound').addEventListener('click', () => vscode.postMessage({ type: 'selectSound' }));
    resetSound.addEventListener('click', () => vscode.postMessage({ type: 'resetSound' }));
    document.getElementById('testAlert').addEventListener('click', () => vscode.postMessage({ type: 'testAlert' }));
    document.getElementById('openSettings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'config') return;
      const config = event.data.config;
      enabled.checked = config.enabled;
      playSound.checked = config.playSound;
      volume.value = String(config.soundVolume);
      volumeValue.textContent = config.soundVolume + '%';
      soundName.textContent = config.soundName;
      soundName.title = config.soundPath;
      resetSound.disabled = !config.soundPath;
      if (!telegramDirty) {
        telegramEnabled.checked = config.telegramEnabled;
        telegramBotToken.value = config.telegramBotToken;
        telegramChatId.value = config.telegramChatId;
      }
    });
  </script>
</body>
</html>`;
  }
}

class NotifierSettingsViewProvider implements vscode.WebviewViewProvider {
  private static current: NotifierSettingsViewProvider | undefined;
  private view: vscode.WebviewView | undefined;

  constructor() {
    NotifierSettingsViewProvider.current = this;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = NotifierSettingsPanel.getHtml();
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void NotifierSettingsPanel.handleMessage(message);
    });
    webviewView.onDidDispose(() => {
      if (NotifierSettingsViewProvider.current === this) {
        this.view = undefined;
      }
    });
  }

  static refreshActive(): void {
    const webview = NotifierSettingsViewProvider.current?.view?.webview;
    if (webview) {
      void webview.postMessage({ type: 'config', config: NotifierSettingsPanel.getViewConfig() });
    }
  }
}

function updateSettingsConfig(key: string, value: unknown): Thenable<void> {
  return vscode.workspace
    .getConfiguration(configSection)
    .update(key, value, vscode.ConfigurationTarget.Global);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function playGentleSound(cfg: NotifierConfig) {
  try {
    if (activeSoundProcess) {
      output.appendLine('Skipped overlapping notification sound playback.');
      return;
    }

    const bundledPath = vscode.Uri.joinPath(extensionUri, 'media', 'notification.mp3').fsPath;
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const soundPath = resolveSoundPath(cfg.soundPath, bundledPath, workspacePath, os.homedir());
    const quotedSoundPath = toPowerShellSingleQuotedString(soundPath);
    const unitVolume = volumeToUnitInterval(cfg.soundVolume);

    if (process.platform === 'win32') {
      spawnSound(
        'powershell.exe',
        [
          '-Sta',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `
$SoundPath = ${quotedSoundPath}
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $SoundPath -PathType Leaf)) {
  throw "Notification sound does not exist: $SoundPath"
}
Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]$SoundPath)
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (-not $player.NaturalDuration.HasTimeSpan -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 25
}
if (-not $player.NaturalDuration.HasTimeSpan) {
  $player.Close()
  throw "Timed out while loading notification sound: $SoundPath"
}
$player.Volume = ${unitVolume}
$player.Play()
$playbackMs = [Math]::Ceiling($player.NaturalDuration.TimeSpan.TotalMilliseconds) + 150
Start-Sleep -Milliseconds $playbackMs
$player.Close()
`
        ]
      );
      return;
    }

    if (process.platform === 'darwin') {
      spawnSound('afplay', ['-v', unitVolume, soundPath]);
      return;
    }

    spawnSound(
      'ffplay',
      ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', Math.round(cfg.soundVolume).toString(), soundPath],
      () => spawnSound('mpg123', ['-q', '--scale', volumeToMpg123Scale(cfg.soundVolume), soundPath])
    );
  } catch (error) {
    output.appendLine(`Unable to play completion sound: ${String(error)}`);
  }
}

function spawnSound(command: string, args: string[], onFailure?: () => void): ChildProcess {
  const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  activeSoundProcess = child;
  let failedToStart = false;
  child.once('error', (error) => {
    failedToStart = true;
    if (activeSoundProcess === child) {
      activeSoundProcess = undefined;
    }
    if (onFailure) {
      onFailure();
    } else {
      output.appendLine(`Unable to run sound command "${command}": ${String(error)}`);
    }
  });
  child.once('exit', (code) => {
    const wasActive = activeSoundProcess === child;
    if (wasActive) {
      activeSoundProcess = undefined;
    }
    if (!failedToStart && wasActive && code !== 0) {
      if (onFailure) {
        onFailure();
      } else {
        output.appendLine(`Sound command "${command}" exited with code ${code ?? 'unknown'}. Check codexNotifierTelegram.soundPath.`);
      }
    }
  });
  return child;
}

function stopSound() {
  const soundProcess = activeSoundProcess;
  activeSoundProcess = undefined;
  soundProcess?.kill();
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function flashTaskbar(enable: boolean) {
  if (process.platform !== 'win32') {
    return;
  }
  if (!enable && !taskbarFlashing) {
    return;
  }
  taskbarFlashing = enable;

  const workspaceName = getWorkspaceWindowHint();
  const script = `
param([string]$WorkspaceName, [string]$Mode)
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexNotifierTaskbar {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO {
    public UInt32 cbSize;
    public IntPtr hwnd;
    public UInt32 dwFlags;
    public UInt32 uCount;
    public UInt32 dwTimeout;
  }

  [DllImport("user32.dll")]
  private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

  public const UInt32 FLASHW_STOP = 0x00000000;
  public const UInt32 FLASHW_TRAY = 0x00000002;
  public const UInt32 FLASHW_TIMER = 0x00000004;

  public static bool Flash(IntPtr handle, UInt32 flags) {
    FLASHWINFO info = new FLASHWINFO();
    info.cbSize = Convert.ToUInt32(Marshal.SizeOf(typeof(FLASHWINFO)));
    info.hwnd = handle;
    info.dwFlags = flags;
    info.uCount = 0;
    info.dwTimeout = 0;
    return FlashWindowEx(ref info);
  }
}
"@

$windows = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
if ($WorkspaceName) {
  $escapedWorkspaceName = [WildcardPattern]::Escape($WorkspaceName)
  $matches = $windows | Where-Object { $_.MainWindowTitle -like "*$escapedWorkspaceName*" }
  if ($matches) {
    $windows = $matches
  }
}

$flags = if ($Mode -eq "start") {
  [CodexNotifierTaskbar]::FLASHW_TRAY -bor [CodexNotifierTaskbar]::FLASHW_TIMER
} else {
  [CodexNotifierTaskbar]::FLASHW_STOP
}

foreach ($window in $windows) {
  [CodexNotifierTaskbar]::Flash($window.MainWindowHandle, $flags) | Out-Null
}
`;

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script,
      workspaceName,
      enable ? 'start' : 'stop'
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  child.on('error', (error) => output.appendLine(`Unable to ${enable ? 'flash' : 'stop flashing'} taskbar: ${String(error)}`));
}

function getWorkspaceWindowHint(): string {
  return vscode.workspace.workspaceFolders?.[0]?.name ?? '';
}

async function startFlash(): Promise<void> {
  stopFlashOnly();

  const cfg = getConfig();
  const generation = ++pulseGeneration;
  alertActive = true;

  if (cfg.flashMode === 'off') {
    clearNativeStatusPulse();
    return;
  }

  pulseStep = 0;
  isPulseOn = statusPulse[pulseStep].status > 0;
  setAlertStatusFrame(pulseStep);
  applyNativeStatusPulse(statusPulse[pulseStep]);
  await queueWorkbenchPulse(statusPulse[pulseStep], generation);
  if (generation !== pulseGeneration || !alertActive) {
    return;
  }

  output.appendLine('Green Codex completion item started.');
  ignoreInteractionUntil = Date.now() + interactionGraceMs;
  if (cfg.maxFlashSeconds > 1) {
    maxFlashTimer = setTimeout(() => stopAlert(), cfg.maxFlashSeconds * 1000);
  }
  if (cfg.stopOnInteraction) {
    startInputWatcher(generation);
  }

  flashTimer = setInterval(() => {
    if (generation !== pulseGeneration || !alertActive) {
      return;
    }
    pulseStep = (pulseStep + 1) % statusPulse.length;
    isPulseOn = statusPulse[pulseStep].status > 0;
    setAlertStatusFrame(pulseStep);
    applyPulse(statusPulse[pulseStep], generation);
  }, cfg.flashIntervalMs);

}

function startInputWatcher(generation: number) {
  if (process.platform !== 'win32') {
    return;
  }

  stopInputWatcher();

  const script = `
$GraceMs = ${interactionGraceMs}
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexNotifierInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public UInt32 cbSize;
    public UInt32 dwTime;
  }

  [DllImport("user32.dll")]
  private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

  public static UInt32 GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = Convert.ToUInt32(Marshal.SizeOf(typeof(LASTINPUTINFO)));
    if (!GetLastInputInfo(ref info)) {
      return 0;
    }
    return info.dwTime;
  }
}
"@

Start-Sleep -Milliseconds $GraceMs
$baseline = [CodexNotifierInput]::GetLastInputTick()
while ($true) {
  Start-Sleep -Milliseconds 120
  $latest = [CodexNotifierInput]::GetLastInputTick()
  if ($latest -ne 0 -and $baseline -ne 0 -and $latest -ne $baseline) {
    exit 7
  }
}
`;

  inputWatcher = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script
    ],
    { windowsHide: true, stdio: 'ignore' }
  );

  inputWatcher.on('exit', (code) => {
    inputWatcher = undefined;
    if (code === 7 && generation === pulseGeneration && alertActive) {
      output.appendLine('Completion alert dismissed by Windows keyboard or mouse input.');
      stopAlert();
    }
  });
  inputWatcher.on('error', (error) => output.appendLine(`Unable to start input watcher: ${String(error)}`));
}

function stopInputWatcher() {
  if (!inputWatcher) {
    return;
  }

  const watcher = inputWatcher;
  inputWatcher = undefined;
  watcher.kill();
}

function restartFlash() {
  if (!alertActive) {
    return;
  }
  stopFlashOnly();
  void startFlash();
}

interface StatusPulseStep {
  readonly label: string;
  readonly status: number;
}

const statusPulse: readonly StatusPulseStep[] = [
  { label: '       >>>>> CODEX IS DONE <<<<<       ', status: 1.00 },
  { label: '                                        ', status: 0.00 }
] as const;

function setAlertStatusFrame(frame: number) {
  statusBar.text = statusPulse[frame % statusPulse.length].label;
  statusBar.tooltip = 'Codex work finished. Click to dismiss the alert.';
}

function applyPulse(step: StatusPulseStep, generation: number) {
  const mode = getConfig().flashMode;
  if (mode === 'workbenchColors' || mode === 'editorOverlay') {
    applyNativeStatusPulse(step);
  } else {
    clearNativeStatusPulse();
  }
}

function applyNativeStatusPulse(step: StatusPulseStep) {
  if (step.status > 0) {
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    clearNativeStatusPulse();
  }
}

function clearNativeStatusPulse() {
  statusBar.backgroundColor = undefined;
  statusBar.color = undefined;
}

function queueWorkbenchPulse(step: StatusPulseStep, generation: number): Thenable<void> {
  workbenchUpdateQueue = workbenchUpdateQueue.then(
    () => applyWorkbenchPulse(step, generation),
    () => applyWorkbenchPulse(step, generation)
  );
  return workbenchUpdateQueue;
}

async function applyWorkbenchPulse(step: StatusPulseStep, generation: number) {
  if (generation !== pulseGeneration || !alertActive) {
    return;
  }

  const cfg = getConfig();
  const workspaceAvailable = Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  const preferredTarget = cfg.workbenchColorTarget === 'global' || !workspaceAvailable
    ? vscode.ConfigurationTarget.Global
    : vscode.ConfigurationTarget.Workspace;
  const configuration = vscode.workspace.getConfiguration();
  const current = configuration.get<Record<string, unknown>>('workbench.colorCustomizations');
  const inspected = configuration.inspect<Record<string, unknown>>('workbench.colorCustomizations');
  const targets = workbenchRestore
    ? [workbenchRestore.target]
    : preferredTarget === vscode.ConfigurationTarget.Workspace
      ? [vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.Global]
      : [vscode.ConfigurationTarget.Global];
  let lastError: unknown;

  for (const target of targets) {
    const restore = workbenchRestore ?? {
      target,
      originalValue: target === vscode.ConfigurationTarget.Global
        ? inspected?.globalValue
        : inspected?.workspaceValue,
      originalEffectiveValue: current ? { ...current } : undefined
    };
    const next = { ...(current ?? {}) };
    const pulseColors: Record<string, string | undefined> = {
      'statusBarItem.warningBackground': '#2EB872',
      'statusBarItem.warningForeground': '#EAFFF2'
    };

    for (const [key, value] of Object.entries(pulseColors)) {
      if (value) {
        next[key] = value;
      } else if (restore.originalEffectiveValue && key in restore.originalEffectiveValue) {
        next[key] = restore.originalEffectiveValue[key];
      } else {
        delete next[key];
      }
    }

    try {
      await configuration.update('workbench.colorCustomizations', next, target);
      workbenchRestore ??= restore;
      if (target !== preferredTarget) {
        output.appendLine('Workspace colors were unavailable; using global colors for this alert.');
      }
      if (generation === pulseGeneration && alertActive && step.status > 0) {
        applyNativeStatusPulse(step);
      }
      return;
    } catch (error) {
      lastError = error;
      if (workbenchRestore) {
        break;
      }
    }
  }

  output.appendLine(`Unable to apply green completion colors: ${String(lastError)}`);
}

function dismissOnInteraction(reason: string) {
  const cfg = getConfig();
  if (!alertActive || !cfg.stopOnInteraction || Date.now() < ignoreInteractionUntil) {
    return;
  }

  output.appendLine(`Completion alert dismissed by ${reason}.`);
  stopAlert();
}

function stopAlert() {
  stopFlashOnly();
  flashTaskbar(false);
  closeNotificationToasts();
  alertActive = false;
  isPulseOn = false;
  statusBar.hide();
}

function closeNotificationToasts() {
  void vscode.commands.executeCommand('notifications.hideToasts').then(
    undefined,
    (error) => output.appendLine(`Unable to run notification close command "notifications.hideToasts": ${String(error)}`)
  );
}

function stopFlashOnly() {
  pulseGeneration += 1;
  stopInputWatcher();
  clearNativeStatusPulse();

  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = undefined;
  }

  if (maxFlashTimer) {
    clearTimeout(maxFlashTimer);
    maxFlashTimer = undefined;
  }

  if (workbenchRestore) {
    const restore = workbenchRestore;
    workbenchRestore = undefined;
    workbenchUpdateQueue = workbenchUpdateQueue.then(
      () => restoreWorkbenchColors(restore),
      () => restoreWorkbenchColors(restore)
    );
  }
}

async function restoreWorkbenchColors(restore: WorkbenchRestore) {
  try {
    await vscode.workspace
      .getConfiguration()
      .update('workbench.colorCustomizations', restore.originalValue, restore.target);
  } catch (error) {
    output.appendLine(`Unable to restore workbench colors: ${String(error)}`);
  }
}

function refreshStatus() {
  if (!getConfig().enabled) {
    statusBar.hide();
  }
}
