---
name: desktop-widget-v2
description: Build, run, tweak, and package the desktop-widget-v2 Electron pet that combines a reactive desktop companion with OpenClaw bridge chat, English voice replies, microphone input via a separate controls window, and natural-language task execution. Use when working on /Users/tricia/clawd-animation/desktop-widget-v2 for UI fixes, bridge debugging, voice/TTS/transcription tuning, controls-window behavior, coding-task execution, packaging, or publishing this widget for others to reuse.
---

# Desktop Widget V2

Work in `/Users/tricia/clawd-animation/desktop-widget-v2` unless the user says otherwise.

## Main behaviors

- Keep the pet window stable first: drag, click reactions, state changes, and speech should keep working.
- Treat advanced controls as separate from the pet body. Prefer the dedicated controls window over stuffing more controls into the pet window.
- Default chat path: renderer -> `clawd-preview-reply` -> local bridge server (`bridge-server.js`) -> dedicated OpenClaw session.
- Default English voice path: `clawd-speak` -> `noiz-tts.js` with `voice-reference.wav`, then `openai-tts.js`, then system `say` voice.
- Controls window lives in `src/controls.html`; the pet window opens it from the `…` button.

## Files to inspect first

- `src/main.js` — Electron main process, bridge lifecycle, controls-window creation, TTS, coding-task IPC
- `src/renderer.js` — pet-window interactions and chat trigger
- `src/preload.js` — IPC surface exposed to renderer/controls
- `src/controls.html` — separate controls window UI for text/voice tasking
- `bridge-server.js` — local HTTP bridge to OpenClaw dedicated chat session
- `noiz-tts.js`, `openai-tts.js`, `transcribe-audio.js`, `claude-code-agent.mjs`

## Run / test

Use these repo scripts:

```bash
npm run pet
npm run pet:stop
npm run pet:log
```

After JS edits, syntax-check the touched files with `node --check` before asking the user to restart.

## Implementation rules

1. Do not break the pet body to add controls.
2. If a control is hard to click inside the pet window, move it to `controls.html` instead of fighting hit-testing.
3. If the bridge feels broken, verify:
   - `bridge-server.js` is running on `127.0.0.1:4317`
   - `clawd-preview-reply` returns the live bridge reply
   - renderer is speaking the same reply it displays
4. If English output regresses, inspect both:
   - `bridge-server.js` prompt wrapper
   - `speakText()` selection logic in `src/main.js`
5. If users want task execution by natural language, prefer letting normal text/voice messages flow through first. Only add explicit mode buttons when truly necessary.

## Publishing guidance

When preparing this repo for others:

- Keep `SKILL.md` concise.
- Do not add extra documentation clutter unless the user explicitly wants it.
- Mention the required runtime assumptions clearly: Electron app, OpenClaw bridge, local helper scripts, and voice reference audio.
- Commit workspace changes after edits.
