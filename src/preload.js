const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  moveWindowBy: (dx, dy) => ipcRenderer.send("move-window-by", dx, dy),
  onStateChange: (callback) => ipcRenderer.on("state-change", (_, state, svg) => callback(state, svg)),
  onEyeMove: (callback) => ipcRenderer.on("eye-move", (_, dx, dy) => callback(dx, dy)),
  onWakeFromDoze: (callback) => ipcRenderer.on("wake-from-doze", () => callback()),
  pauseCursorPolling: () => ipcRenderer.send("pause-cursor-polling"),
  resumeFromReaction: () => ipcRenderer.send("resume-from-reaction"),
  onDndChange: (callback) => ipcRenderer.on("dnd-change", (_, enabled) => callback(enabled)),
  dragLock: (locked) => ipcRenderer.send("drag-lock", locked),
  onMiniModeChange: (cb) => ipcRenderer.on("mini-mode-change", (_, enabled) => cb(enabled)),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  setChatFocus: (focused) => ipcRenderer.send("clawd-chat-focus", focused),
  openControls: () => ipcRenderer.send("clawd-open-controls"),
});

function rendererLog(event, data = {}) {
  return ipcRenderer.invoke("clawd-renderer-log", { event, ...data });
}

contextBridge.exposeInMainWorld("clawdVoice", {
  speak: (text, voice) => ipcRenderer.invoke("clawd-speak", { text, voice }),
  previewReply: (text) => ipcRenderer.invoke("clawd-preview-reply", { text }),
  bridgeStatus: () => ipcRenderer.invoke("clawd-bridge-status"),
  setBridgeMode: (enabled, sessionKey) => ipcRenderer.invoke("clawd-set-bridge-mode", { enabled, sessionKey }),
  transcribeAudio: (audioPath) => ipcRenderer.invoke("clawd-transcribe-audio", { audioPath }),
  transcribeAudioBuffer: (buffer, extension) => ipcRenderer.invoke("clawd-transcribe-audio-buffer", { buffer, extension }),
  toggleAmbient: () => ipcRenderer.invoke("clawd-toggle-ambient"),
  runCodingTask: (text) => ipcRenderer.invoke("clawd-run-coding-task", { text }),
  onReply: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("clawd-reply", listener);
    return () => ipcRenderer.removeListener("clawd-reply", listener);
  },
  debugLog: (event, data) => rendererLog(event, data),
});
