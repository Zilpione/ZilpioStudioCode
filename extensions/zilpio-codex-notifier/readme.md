# Zilpio Codex Notifier

A small VS Code extension that lets Codex completion alerts reach you through sound, a visual indicator, and optionally Telegram.

This project builds on [Codex Finish Notifier by Dankh917](https://github.com/Dankh917/VSC-CODEX-NOTIFIER). Thanks to Dankh917 for the original extension and for releasing it under the MIT License. This version keeps the original completion detection and adds Telegram notifications. It is an independent community project and is not affiliated with OpenAI or Telegram.

VS Code extension that plays a gentle completion sound, shows a compact CLI-style status bar pulse, and optionally sends a Telegram message when Codex work finishes.

## What Works Automatically

- Detects `codex` CLI commands in terminals when VS Code shell integration is active.
- Detects Codex work from the OpenAI Codex VS Code extension using local completion markers, plus guarded fallbacks for both current turn/read-state logs and legacy stream/read-state logs.
- Plays the bundled notification MP3, or a custom audio clip, when the command ends.
- Sends a Telegram completion message to your configured bot chat when Telegram is enabled.
- Blinks a wide green `>>>>> CODEX IS DONE <<<<<` status item on and off until you focus/interact with VS Code or dismiss it.

The completion item uses VS Code's native warning-style status item, so it works in classic and Modern UI layouts as well as light, dark, and high-contrast themes. If workspace color settings cannot be written, the notifier falls back to global color settings for that alert.

The OpenAI Codex VS Code extension does not expose a public VS Code extension API event for "turn completed", so this extension watches local VS Code extension-host output from the OpenAI Codex extension. Strong completion markers are used when available; chat-only turns correlate a logged turn start with its final read-state event. The earlier stream/read-state format remains supported.

## Commands

- `Zilpio Codex Notifier: Notify Codex Done` starts the completion alert manually.
- `Zilpio Codex Notifier: Test Completion Alert` tests the sound and visual pulse.
- `Zilpio Codex Notifier: Select Notification Sound` imports a custom audio clip into persistent VS Code extension storage.
- `Zilpio Codex Notifier: Dismiss Completion Alert` stops the current alert.
- `Zilpio Codex Notifier: Mark Codex Started` shows a "Codex working" status item for manually tracked work.

## Codex Toolbar Settings

Select the settings-gear button in the Codex task or sidebar title toolbar to open the quick settings panel. It provides a volume slider, notifier and sound toggles, custom audio upload/reset, a test button, and a shortcut to all extension settings. Uploaded audio is copied into persistent extension storage, so the original file can be moved or deleted afterward.

The Zilpio Codex Notifier bell is also available in the VS Code Activity Bar. Click it to open the `Notification Settings` view with the volume slider, sound file picker, and a button to reset to the bundled default sound directly in the sidebar.

The same panel and sidebar include Telegram controls: enable/disable notifications, a masked bot token field, Chat ID, **Save Telegram settings**, and **Send test message**. The Telegram test uses the current fields even if automatic notifications are disabled, and does not save them. Other notifier controls continue to save automatically.

## Telegram setup

1. Create a bot with [BotFather](https://t.me/BotFather) using `/newbot` and copy its token.
2. Open a private chat with your new bot and press **Start** (or send `/start`). For a group, add the bot and send a command addressed to it. For a channel, add it with permission to post messages.
3. Obtain the destination Chat ID. For a bot you control that does not already use a webhook or another polling client, call the Telegram Bot API `getUpdates` method locally after sending a message and read `result[].message.chat.id`. Keep any minus sign for groups. Public channels can use `@channelusername`. See the official [getUpdates documentation](https://core.telegram.org/bots/api#getupdates).
4. In VS Code, click the settings gear in the Codex toolbar (or open **Zilpio Codex Notifier: Open Notifier Settings**). Enter **Bot token** and **Chat ID**, enable Telegram, then click **Save Telegram settings**.
5. Click **Send test message**. VS Code will report success or an error. The main **Enable notifier** switch must also be on for automatic completion messages.

Alternatively, add these keys to your **User** `settings.json`:

```json
{
  "codexNotifierTelegram.enabled": true,
  "codexNotifierTelegram.playSound": true,
  "codexNotifierTelegram.telegram.enabled": true,
  "codexNotifierTelegram.telegram.botToken": "123456789:YOUR_BOT_TOKEN",
  "codexNotifierTelegram.telegram.chatId": "123456789"
}
```

The token is stored in plain text in your User settings, not in encrypted secret storage. Do not put it in a repository or share that file. Telegram settings are machine-scoped, so they are not synchronized by VS Code Settings Sync.

Each accepted completion sends `✅ Codex ha terminato il task.` through Telegram's [sendMessage API](https://core.telegram.org/bots/api#sendmessage). The message contains no prompt, answer, file path, or terminal command. Telegram works independently of the sound toggle and follows the existing completion deduplication. Requests time out after 10 seconds and are not automatically retried, to avoid duplicate messages. Telegram errors appear in the **Zilpio Codex Notifier** Output channel without the token and do not interrupt local alerts. **Test alert** also sends a completion message if Telegram is enabled.

### Install the modified extension

Download the `.vsix` from the project releases. In VS Code, run **Extensions: Install from VSIX...** and select it, then reload the window if prompted.

This fork has its own extension identifier (`zilpio.codex-notifier-telegram`) and uses `codexNotifierTelegram.*` settings. Disable or uninstall the original **Codex Finish Notifier** (including the earlier local Telegram build) before using this fork, to avoid duplicate alerts and overlapping keyboard hooks. Settings and imported sounds from the original are not migrated automatically: configure this extension's panel, or copy the desired User settings using the new prefix, and reselect custom audio if needed.

To create the package yourself, run `npm ci`, `npm test`, then `npx @vscode/vsce package --no-dependencies`.

## Settings

- `codexNotifierTelegram.enabled`: turn the extension on/off.
- `codexNotifierTelegram.playSound`: enable/disable the completion sound.
- `codexNotifierTelegram.soundVolume`: sound volume from `0` (muted) to `100`. Default is `50`.
- `codexNotifierTelegram.soundPath`: optional custom audio path. Leave empty for the bundled MP3; relative paths use the first workspace folder. Using the sound picker imports a managed copy into persistent VS Code storage.
- `codexNotifierTelegram.flashMode`: `workbenchColors`, `editorOverlay`, or `off`. `workbenchColors` and `editorOverlay` now keep the visual alert limited to the status bar.
- `codexNotifierTelegram.stopOnInteraction`: stop flashing when the user focuses or interacts with VS Code.
- `codexNotifierTelegram.flashIntervalMs`: pulse speed. Default is `900`; larger values blink slower.
- `codexNotifierTelegram.maxFlashSeconds`: optional safety timeout. `0` or `1` keeps the alert active until interaction or dismissal.
- `codexNotifierTelegram.detectTerminalCodex`: detect terminal Codex CLI completion.
- `codexNotifierTelegram.detectOpenAiCodexLog`: detect Codex completion from the OpenAI Codex extension's local turn-state output.
- `codexNotifierTelegram.openAiCodexDetectionMode`: `chatHeuristic` catches chat-only turns from current turn/read-state logs and legacy stream/read-state logs; `conservative` only uses stronger local completion markers.
- `codexNotifierTelegram.detectCodexProcess`: detect completion by watching short-lived Codex process exit. Off by default because the OpenAI Codex extension app-server is long-lived.
- `codexNotifierTelegram.processPollIntervalMs`: how often to check Codex process state.
- `codexNotifierTelegram.terminalCommandPattern`: regex for terminal commands to treat as Codex work.
- `codexNotifierTelegram.taskbarFlash`: on Windows, flash the VS Code taskbar icon while the alert is active.

`workbenchColors` is the default because VS Code only exposes custom status bar background colors through `workbench.colorCustomizations`. The extension temporarily updates only `statusBar.background` and `statusBar.foreground`, then restores the previous values when dismissed. If workspace scope is selected but no workspace is open, the notifier automatically uses global scope for the temporary pulse. Use `off` if you want sound/taskbar flashing without the green status bar pulse.

The notifier keeps one audio player active at a time and ignores duplicate completion signals while an alert is active. This prevents overlapping playback when terminal and Codex-log detection report the same completion.

On Windows, interaction dismissal starts after a short grace period so the first green status-bar pulse is always visible. Input that occurs after the grace period dismisses the alert normally.

## Run Locally

1. Run `npm install`.
2. Run `npm run compile`.
3. Open this folder in VS Code.
4. Press `F5` and choose `Run Extension`.
5. In the extension host window, run `Zilpio Codex Notifier: Test Completion Alert` from the Command Palette.

## Notes

Mouse movement alone is not exposed as a global VS Code extension event. The extension stops on supported interaction signals: window focus, active editor changes, mouse clicks that move the editor selection, scrolling/visible range changes, text document edits, active terminal changes, terminal command starts, and visible editor changes.
