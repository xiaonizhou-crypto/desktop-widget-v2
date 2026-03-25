const { app, BrowserWindow, screen, Menu, Tray, ipcMain, nativeImage } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const os = require("os");

const V2_ROOT = path.join(__dirname, "..");
const BRIDGE_STATE_PATH = path.join(V2_ROOT, ".clawd-bridge-state.json");
const DEFAULT_TTS_VOICE = "Grandpa (英语（美国）)";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4317/chat";
const DEFAULT_BRIDGE_HEALTH_URL = "http://127.0.0.1:4317/health";
const BRIDGE_SERVER_PATH = path.join(V2_ROOT, "bridge-server.js");

let bridgeProcess = null;
let bridgeStartingPromise = null;
let bridgeLastHealth = { ok: false, checkedAt: 0, error: "not_checked" };

function debugLog(...args) {
  console.log("[clawd-v2][main]", ...args);
}

function playAudioFile(audioPath) {
  return new Promise((resolve) => {
    if (!audioPath || !fs.existsSync(audioPath)) {
      resolve({ ok: false, reason: "missing_audio_file" });
      return;
    }
    const player = process.platform === "darwin" ? "afplay" : null;
    if (!player) {
      resolve({ ok: false, reason: "unsupported_playback_platform", audioPath });
      return;
    }
    const child = spawn(player, [audioPath], { stdio: "ignore" });
    child.on("error", (error) => resolve({ ok: false, reason: error.message, audioPath }));
    child.on("exit", (code) => resolve({ ok: code === 0, code, audioPath, provider: player }));
  });
}

function sanitizeSpeakText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/["`$\\]/g, "")
    .trim()
    .slice(0, 240);
}

function speakWithSystemVoice(text, voice = DEFAULT_TTS_VOICE) {
  return new Promise((resolve) => {
    const clean = sanitizeSpeakText(text);
    if (!clean) return resolve({ ok: false, reason: "empty" });
    if (process.platform !== "darwin") return resolve({ ok: false, reason: "unsupported_system_voice_platform" });
    const args = voice ? ["-v", voice, clean] : [clean];
    const child = spawn("say", args, { stdio: "ignore" });
    child.on("error", (error) => resolve({ ok: false, reason: error.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, code, voice, provider: "system" }));
  });
}

function runNodeTtsScript(scriptName, input) {
  return new Promise((resolve, reject) => {
    execFile("node", [path.join(V2_ROOT, scriptName), input], {
      cwd: V2_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message || `${scriptName}_failed`));
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed?.ok) return reject(new Error(parsed?.error || `${scriptName}_failed`));
        resolve(parsed);
      } catch (e) {
        reject(new Error(`${scriptName}_invalid_response: ${stdout || stderr || e.message}`));
      }
    });
  });
}

async function speakText(text, voice = DEFAULT_TTS_VOICE) {
  const clean = sanitizeSpeakText(text);
  if (!clean) return { ok: false, reason: "empty" };
  const looksEnglish = /[A-Za-z]/.test(clean) && !/[\u4e00-\u9fff]/.test(clean);

  if (looksEnglish) {
    try {
      const noizBase = await runNodeTtsScript("noiz-tts.js", clean);
      return { ok: true, provider: "noiz", audioPath: noizBase.path, refAudio: noizBase.refAudio || null, language: "en" };
    } catch (noizBaseError) {
      try {
        const openai = await runNodeTtsScript("openai-tts.js", clean);
        return { ok: true, provider: "openai", audioPath: openai.path, fallbackFrom: "noiz", reason: noizBaseError.message, language: "en" };
      } catch (openaiError) {
        const fallback = await speakWithSystemVoice(clean, voice);
        return { ok: fallback.ok, fallback: true, reason: `${noizBaseError.message} | ${openaiError.message}`, language: "en", ...fallback };
      }
    }
  }

  const fallback = await speakWithSystemVoice(clean, voice);
  return { ok: fallback.ok, fallback: true, reason: "non_english_text_system_voice_only", language: "non-en", ...fallback };
}

function chooseReplyState(replyText) {
  const text = String(replyText || "").trim();
  if (!text) return "attention";
  if (/错误|失败|异常|报错|不行|没接好|稍等|重试/.test(text)) return "error";
  if (/好呀|可以|收到|我在|抱抱|陪你|回来|听见/.test(text)) return "attention";
  return "notification";
}

function buildPreviewReply(input) {
  const text = String(input || "").trim();
  if (!text) return "我在呢。";
  if (/音乐|bgm|背景音乐|播放/.test(text)) return "好呀。等我再长一点，就能放给你听。";
  if (/总结|整理|归纳/.test(text)) return "嗯，给我吧。\n我帮你慢慢理清。";
  if (/你好|在吗|宝宝|陪我/.test(text)) return "我在呀。\n过来一点。";
  return `我听见了。\n${text.length > 18 ? "你慢一点说，我都接着。" : "我在这儿。"}`;
}

function loadBridgeState() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_STATE_PATH, "utf8"));
  } catch {
    return {
      enabled: false,
      mode: "preview",
      sessionKey: "agent:main:chat-clawd",
      bridgeUrl: DEFAULT_BRIDGE_URL,
      voice: DEFAULT_TTS_VOICE,
    };
  }
}

function saveBridgeState(next) {
  fs.writeFileSync(BRIDGE_STATE_PATH, JSON.stringify(next, null, 2), "utf8");
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      },
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw || "{}")); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getBridgeHealthUrl(bridgeUrl) {
  try {
    const parsed = new URL(bridgeUrl || DEFAULT_BRIDGE_URL);
    parsed.pathname = "/health";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return DEFAULT_BRIDGE_HEALTH_URL;
  }
}

function getBridgeStatusSnapshot(extra = {}) {
  const healthy = !!bridgeLastHealth?.ok;
  return {
    ok: true,
    ...bridgeState,
    connected: !!bridgeState.enabled && healthy,
    health: {
      ...bridgeLastHealth,
      url: getBridgeHealthUrl(bridgeState.bridgeUrl),
    },
    bridgeProcessRunning: !!(bridgeProcess && !bridgeProcess.killed),
    ...extra,
  };
}

function checkBridgeHealth(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const healthUrl = getBridgeHealthUrl(bridgeState.bridgeUrl);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      bridgeLastHealth = {
        checkedAt: Date.now(),
        ...result,
      };
      resolve(bridgeLastHealth);
    };

    try {
      const parsed = new URL(healthUrl);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
      }, (res) => {
        let raw = "";
        res.on("data", (chunk) => raw += chunk);
        res.on("end", () => {
          try {
            const data = JSON.parse(raw || "{}");
            finish({ ok: res.statusCode >= 200 && res.statusCode < 300 && !!data?.ok, statusCode: res.statusCode, data });
          } catch (error) {
            finish({ ok: false, statusCode: res.statusCode, error: error.message || "invalid_health_response" });
          }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error("bridge_health_timeout")));
      req.on("socket", (socket) => {
        socket.setTimeout(timeoutMs);
      });
      req.on("error", (error) => finish({ ok: false, error: error.message || "bridge_health_failed" }));
      req.end();
    } catch (error) {
      finish({ ok: false, error: error.message || "bridge_health_url_invalid" });
    }
  });
}

async function ensureBridgeRunning() {
  if (!bridgeState.enabled) return { ok: false, reason: "bridge_disabled" };
  const currentHealth = await checkBridgeHealth(3000);
  if (currentHealth.ok) return { ok: true, reused: true, health: currentHealth };
  if (bridgeStartingPromise) return bridgeStartingPromise;

  bridgeStartingPromise = new Promise((resolve) => {
    if (!fs.existsSync(BRIDGE_SERVER_PATH)) {
      const result = { ok: false, error: "bridge_server_missing" };
      bridgeLastHealth = { ok: false, checkedAt: Date.now(), error: result.error };
      bridgeStartingPromise = null;
      resolve(result);
      return;
    }

    debugLog("bridge:start", { bridgeServerPath: BRIDGE_SERVER_PATH, bridgeUrl: bridgeState.bridgeUrl });
    const child = spawn("node", [BRIDGE_SERVER_PATH], {
      cwd: V2_ROOT,
      env: {
        ...process.env,
        CLAWD_BRIDGE_PORT: String(new URL(bridgeState.bridgeUrl || DEFAULT_BRIDGE_URL).port || "4317"),
        CLAWD_SESSION_KEY: bridgeState.sessionKey || "agent:main:chat-clawd",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bridgeProcess = child;

    child.stdout.on("data", (chunk) => debugLog("bridge:stdout", String(chunk).trim()));
    child.stderr.on("data", (chunk) => debugLog("bridge:stderr", String(chunk).trim()));
    child.on("error", (error) => {
      debugLog("bridge:spawn-error", error?.message || String(error));
    });
    child.on("exit", (code, signal) => {
      debugLog("bridge:exit", { code, signal });
      if (bridgeProcess === child) bridgeProcess = null;
    });

    const startedAt = Date.now();
    const poll = async () => {
      const health = await checkBridgeHealth(3000);
      if (health.ok) {
        bridgeStartingPromise = null;
        resolve({ ok: true, started: true, health });
        return;
      }
      if (!bridgeProcess || bridgeProcess.killed) {
        bridgeStartingPromise = null;
        resolve({ ok: false, error: "bridge_process_exited", health });
        return;
      }
      if (Date.now() - startedAt > 12000) {
        stopBridgeProcess();
        bridgeStartingPromise = null;
        resolve({ ok: false, error: "bridge_start_timeout", health });
        return;
      }
      setTimeout(poll, 700);
    };
    setTimeout(poll, 500);
  });

  return bridgeStartingPromise;
}

function stopBridgeProcess() {
  if (!bridgeProcess || bridgeProcess.killed) return;
  try {
    bridgeProcess.kill("SIGTERM");
  } catch {}
}

// ── Window size presets ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// ── Internationalization ──
const i18n = {
  en: {
    size: "Size",
    small: "Small (S)",
    medium: "Medium (M)",
    large: "Large (L)",
    miniMode: "Mini Mode",
    exitMiniMode: "Exit Mini Mode",
    sleep: "Sleep (Do Not Disturb)",
    wake: "Wake Clawd",
    startOnLogin: "Start on Login",
    language: "Language",
    quit: "Quit",
  },
  zh: {
    size: "大小",
    small: "小 (S)",
    medium: "中 (M)",
    large: "大 (L)",
    miniMode: "极简模式",
    exitMiniMode: "退出极简模式",
    sleep: "休眠（免打扰）",
    wake: "唤醒 Clawd",
    startOnLogin: "开机自启",
    language: "语言",
    quit: "退出",
  },
};
let lang = "en";
function t(key) { return (i18n[lang] || i18n.en)[key] || key; }

// ── Position persistence ──
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");

function loadPrefs() {
  try {
    const raw = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    // Sanitize numeric fields — corrupted JSON can feed NaN into window positioning
    for (const key of ["x", "y", "preMiniX", "preMiniY"]) {
      if (key in raw && (typeof raw[key] !== "number" || !isFinite(raw[key]))) {
        raw[key] = 0;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

function savePrefs() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  const data = {
    x, y, size: currentSize,
    miniMode, preMiniX, preMiniY, lang,
  };
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(data)); } catch {}
}

// ── SVG filename constants (used across main + renderer via IPC) ──
const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";
const SVG_IDLE_LOOK = "clawd-idle-look.svg";

// ── State → SVG mapping ──
const STATE_SVGS = {
  idle: [SVG_IDLE_FOLLOW],
  yawning: ["clawd-idle-yawn.svg"],
  dozing: ["clawd-idle-doze.svg"],
  collapsing: ["clawd-collapse-sleep.svg"],
  thinking: ["clawd-working-thinking.svg"],
  working: ["clawd-working-typing.svg"],
  juggling: ["clawd-working-juggling.svg"],
  sweeping: ["clawd-working-sweeping.svg"],
  error: ["clawd-error.svg"],
  attention: ["clawd-happy.svg"],
  notification: ["clawd-notification.svg"],
  carrying: ["clawd-working-carrying.svg"],
  sleeping: ["clawd-sleeping.svg"],
  waking: ["clawd-wake.svg"],
};

// Mini mode SVG mappings
STATE_SVGS["mini-idle"]  = ["clawd-mini-idle.svg"];
STATE_SVGS["mini-alert"] = ["clawd-mini-alert.svg"];
STATE_SVGS["mini-happy"] = ["clawd-mini-happy.svg"];
STATE_SVGS["mini-enter"] = ["clawd-mini-enter.svg"];
STATE_SVGS["mini-peek"]  = ["clawd-mini-peek.svg"];
STATE_SVGS["mini-crabwalk"] = ["clawd-mini-crabwalk.svg"];
STATE_SVGS["mini-enter-sleep"] = ["clawd-mini-enter-sleep.svg"];
STATE_SVGS["mini-sleep"] = ["clawd-mini-sleep.svg"];

const MIN_DISPLAY_MS = {
  attention: 4000,
  error: 5000,
  sweeping: 2000,
  notification: 4000,
  carrying: 3000,
  working: 1000,
  thinking: 1000,
  "mini-alert": 4000,
  "mini-happy": 4000,
};

// Oneshot states that auto-return to idle (subset of MIN_DISPLAY_MS)
const AUTO_RETURN_MS = {
  attention: 4000,
  error: 5000,
  sweeping: 300000,  // 5min safety; PostCompact ends sweeping normally
  notification: 4000,  // matches SVG animation loop (4s)
  carrying: 3000,
  "mini-alert": 4000,
  "mini-happy": 4000,
};

const MOUSE_IDLE_TIMEOUT = 20000;   // 20s → idle-look
const MOUSE_SLEEP_TIMEOUT = 60000;  // 60s → yawning → dozing
const DEEP_SLEEP_TIMEOUT = 600000;  // 10min → collapsing → sleeping
const YAWN_DURATION = 3000;
const COLLAPSE_DURATION = 800;
const WAKE_DURATION = 1500;
const IDLE_LOOK_DURATION = 10000;  // idle-look CSS loop is 10s
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping", "waking"]);

// ── Session tracking ──
const sessions = new Map(); // session_id → { state, updatedAt }
const SESSION_STALE_MS = 300000; // 5 min cleanup
const STATE_PRIORITY = {
  error: 8, notification: 7, sweeping: 6, attention: 5,
  carrying: 4, juggling: 4, working: 3, thinking: 2, idle: 1, sleeping: 0,
};

// ── CSS <object> sizing (mirrors styles.css #clawd) ──
const OBJ_SCALE_W = 1.9;   // width: 190%
const OBJ_SCALE_H = 1.3;   // height: 130%
const OBJ_OFF_X   = -0.45; // left: -45%
const OBJ_OFF_Y   = -0.25; // top: -25%

function getObjRect(bounds) {
  return {
    x: bounds.x + bounds.width * OBJ_OFF_X,
    y: bounds.y + bounds.height * OBJ_OFF_Y,
    w: bounds.width * OBJ_SCALE_W,
    h: bounds.height * OBJ_SCALE_H,
  };
}

// ── Hit-test bounding boxes (SVG coordinate system) ──
const HIT_BOXES = {
  default:  { x: -1, y: 5, w: 17, h: 12 },   // 站姿：身体+腿+手臂
  sleeping: { x: -2, y: 9, w: 19, h: 7 },     // 趴姿：更宽更矮
  wide:     { x: -3, y: 3, w: 21, h: 14 },    // 带特效（error/building/notification）
};
const WIDE_SVGS = new Set(["clawd-error.svg", "clawd-working-building.svg", "clawd-notification.svg"]);
let currentHitBox = HIT_BOXES.default;

let win;
let controlsWin = null;
let tray = null;
let contextMenuOwner = null;
let currentSize = "S";
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
let bridgeState = loadBridgeState();

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function openControlsWindow() {
  if (controlsWin && !controlsWin.isDestroyed()) {
    if (controlsWin.isVisible()) {
      controlsWin.hide();
      return;
    }
    controlsWin.show();
    controlsWin.focus();
    return;
  }
  if (!win || win.isDestroyed()) return;
  const { x, y, width, height } = win.getBounds();
  controlsWin = new BrowserWindow({
    width: 240,
    height: 120,
    x: x + Math.max(24, Math.round(width * 0.18)),
    y: y + height + 10,
    frame: false,
    transparent: false,
    backgroundColor: '#fff7fa',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  controlsWin.loadFile(path.join(__dirname, 'controls.html'));
  controlsWin.once('ready-to-show', () => {
    if (controlsWin && !controlsWin.isDestroyed()) controlsWin.show();
  });
  controlsWin.on('blur', () => {
    if (controlsWin && !controlsWin.isDestroyed()) controlsWin.hide();
  });
  controlsWin.on('closed', () => { controlsWin = null; });
}


function triggerCompanionState(state, svgOverride = null) {
  if (!STATE_SVGS[state] && !svgOverride) return;
  setState(state, svgOverride || undefined);
}

// ── State machine ──
let currentState = "idle";
let currentSvg = null;
let stateChangedAt = Date.now();
let pendingTimer = null;
let autoReturnTimer = null;
let mainTickTimer = null;
let moveTopTimer = null;
let mouseOverPet = false;
let dragLocked = false;
let menuOpen = false;
let idlePaused = false;
let idleWasActive = false;
let lastEyeDx = 0, lastEyeDy = 0;
let forceEyeResend = false;

// ── Mini Mode ──
const MINI_OFFSET_RATIO = 0.486;
const PEEK_OFFSET = 25;
const SNAP_TOLERANCE = 30;
const JUMP_PEAK_HEIGHT = 40;
const JUMP_DURATION = 350;
const CRABWALK_SPEED = 0.12;  // px/ms

let miniMode = false;
let miniTransitioning = false;
let miniSleepPeeked = false;
let preMiniX = 0, preMiniY = 0;
let currentMiniX = 0;
let miniSnap = null;  // { y, width, height } — canonical rect to prevent DPI drift
let miniTransitionTimer = null;
let peekAnimTimer = null;
let isAnimating = false;


// ── Mouse idle tracking ──
let lastCursorX = null, lastCursorY = null;
let mouseStillSince = Date.now();
let isMouseIdle = false;       // showing idle-look
let hasTriggeredYawn = false;  // 60s threshold already fired
let idleLookPlayed = false;    // idle-look already played once since last movement
let idleLookReturnTimer = null;
let yawnDelayTimer = null;     // tracked setTimeout for yawn/idle-look transitions

// ── Wake poll (during dozing) ──
let wakePollTimer = null;
let lastWakeCursorX = null, lastWakeCursorY = null;

let pendingState = null; // tracks what state is waiting in pendingTimer

function setState(newState, svgOverride) {
  if (doNotDisturb) return;

  // Oneshot events from hooks should always wake from sleep —
  // any hook event means Claude Code is active, Clawd shouldn't stay asleep.

  // Don't re-enter sleep sequence when already in it
  if (newState === "yawning" && SLEEP_SEQUENCE.has(currentState)) return;

  // Don't displace a pending higher-priority state with a lower-priority one
  if (pendingTimer) {
    if (pendingState && (STATE_PRIORITY[newState] || 0) < (STATE_PRIORITY[pendingState] || 0)) {
      return;
    }
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingState = null;
  }

  const sameState = newState === currentState;
  const sameSvg = !svgOverride || svgOverride === currentSvg;
  if (sameState && sameSvg) {
    return;
  }

  const minTime = MIN_DISPLAY_MS[currentState] || 0;
  const elapsed = Date.now() - stateChangedAt;
  const remaining = minTime - elapsed;

  if (remaining > 0) {
    // Cancel current state's auto-return to prevent timer race
    if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
    pendingState = newState;
    const pendingSvgOverride = svgOverride;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const queued = pendingState;
      const queuedSvg = pendingSvgOverride;
      pendingState = null;
      // Oneshot states (error/notification/etc.) are not stored in sessions,
      // so re-resolving would lose them. Apply the queued state directly.
      if (ONESHOT_STATES.has(queued)) {
        applyState(queued, queuedSvg);
      } else {
        // For persistent states, re-resolve from live sessions — the captured
        // state may be stale (e.g. SessionEnd arrived while we waited)
        const resolved = resolveDisplayState();
        applyState(resolved, getSvgOverride(resolved));
      }
    }, remaining);
  } else {
    applyState(newState, svgOverride);
  }
}

function applyState(state, svgOverride) {
  // Mini transition protection: only allow mini-* states through
  if (miniTransitioning && !state.startsWith("mini-")) {
    return;
  }

  // Mini mode interception: redirect to mini variants
  if (miniMode && !state.startsWith("mini-")) {
    if (state === "notification") return applyState("mini-alert");
    if (state === "attention") return applyState("mini-happy");
    // Other states are silent in mini mode — but if we're stuck in a
    // oneshot mini state whose auto-return timer was cancelled (e.g. by
    // setState's pending logic), recover to mini-idle/mini-peek now.
    if (AUTO_RETURN_MS[currentState] && !autoReturnTimer) {
      return applyState(mouseOverPet ? "mini-peek" : "mini-idle");
    }
    return;
  }

  currentState = state;
  stateChangedAt = Date.now();
  idlePaused = false;

  const svgs = STATE_SVGS[state] || STATE_SVGS.idle;
  const svg = svgOverride || svgs[Math.floor(Math.random() * svgs.length)];
  currentSvg = svg;

  // Update hit box based on SVG
  if (svg === "clawd-sleeping.svg" || svg === "clawd-collapse-sleep.svg") {
    currentHitBox = HIT_BOXES.sleeping;
  } else if (WIDE_SVGS.has(svg)) {
    currentHitBox = HIT_BOXES.wide;
  } else {
    currentHitBox = HIT_BOXES.default;
  }

  sendToRenderer("state-change", state, svg);

  // Reset eyes when leaving idle/mini-idle
  if (state !== "idle" && state !== "mini-idle") {
    sendToRenderer("eye-move", 0, 0);
  }

  // Wake poll: dozing, collapsing, sleeping (not DND sleeping)
  if ((state === "dozing" || state === "collapsing" || state === "sleeping") && !doNotDisturb) {
    setTimeout(() => {
      if (currentState === state) startWakePoll();
    }, 500);
  } else {
    stopWakePoll();
  }

  // Sleep/doze sequence: yawning → dozing; waking → resolve session state
  if (autoReturnTimer) clearTimeout(autoReturnTimer);
  if (state === "yawning") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      applyState(doNotDisturb ? "collapsing" : "dozing");
    }, YAWN_DURATION);
  } else if (state === "waking") {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    }, WAKE_DURATION);
  } else if (AUTO_RETURN_MS[state]) {
    autoReturnTimer = setTimeout(() => {
      autoReturnTimer = null;
      if (miniMode) {
        if (mouseOverPet && !doNotDisturb) {
          miniPeekIn();
          applyState("mini-peek");
        } else {
          applyState(doNotDisturb ? "mini-sleep" : "mini-idle");
        }
      } else {
        const resolved = resolveDisplayState();
        applyState(resolved, getSvgOverride(resolved));
      }
    }, AUTO_RETURN_MS[state]);
  }
}

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
  const obj = getObjRect(bounds);

  // viewBox="-15 -25 45 45", preserveAspectRatio default xMidYMid meet
  const scale = Math.min(obj.w, obj.h) / 45;
  const offsetX = obj.x + (obj.w - 45 * scale) / 2;
  const offsetY = obj.y + (obj.h - 45 * scale) / 2;

  const hb = currentHitBox;
  return {
    left:   offsetX + (hb.x + 15) * scale,
    top:    offsetY + (hb.y + 25) * scale,
    right:  offsetX + (hb.x + 15 + hb.w) * scale,
    bottom: offsetY + (hb.y + 25 + hb.h) * scale,
  };
}

function getChatToggleRectScreen(bounds) {
  return {
    left: bounds.x + bounds.width - 12 - 28,
    top: bounds.y + bounds.height - 14 - 28,
    right: bounds.x + bounds.width - 12,
    bottom: bounds.y + bounds.height - 14,
  };
}

function getChatPanelRectScreen(bounds) {
  return {
    left: bounds.x + bounds.width - 46 - 136,
    top: bounds.y + bounds.height + 18 - 34,
    right: bounds.x + bounds.width - 46,
    bottom: bounds.y + bounds.height + 18,
  };
}

function pointInRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// ── Unified main tick (hit-test + eye tracking + sleep detection) ──
function startMainTick() {
  if (mainTickTimer) return;
  win.setIgnoreMouseEvents(true);
  mouseOverPet = false;

  mainTickTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();

    // ── Hit-test (always-on) ──
    const bounds = win.getBounds();
    if (!dragLocked) {
      const petHit = getHitRectScreen(bounds);
      const toggleHit = getChatToggleRectScreen(bounds);
      const panelHit = getChatPanelRectScreen(bounds);
      const overPet = pointInRect(cursor.x, cursor.y, petHit);
      const overToggle = pointInRect(cursor.x, cursor.y, toggleHit);
      const overPanel = pointInRect(cursor.x, cursor.y, panelHit);
      const over = overPet || overToggle || overPanel;
      if (over !== mouseOverPet) {
        mouseOverPet = over;
        win.setIgnoreMouseEvents(!over);
      }
    }

    // ── Mini mode peek hover ──
    if (miniMode && !miniTransitioning && !dragLocked && !menuOpen) {
      const canPeek = currentState === "mini-idle" || currentState === "mini-peek"
        || currentState === "mini-sleep";
      if (!isAnimating && canPeek) {
        if (mouseOverPet && currentState === "mini-sleep" && !miniSleepPeeked) {
          miniPeekIn();
          miniSleepPeeked = true;
        } else if (!mouseOverPet && currentState === "mini-sleep" && miniSleepPeeked) {
          miniPeekOut();
          miniSleepPeeked = false;
        } else if (mouseOverPet && currentState !== "mini-peek" && currentState !== "mini-sleep") {
          miniPeekIn();
          applyState("mini-peek");
        } else if (!mouseOverPet && currentState === "mini-peek") {
          miniPeekOut();
          applyState("mini-idle");
        }
      }
    }

    // ── Eye tracking + sleep detection (idle only, not during reactions) ──
    const idleNow = currentState === "idle" && !idlePaused;
    const miniIdleNow = currentState === "mini-idle" && !idlePaused && !miniTransitioning;

    // Edge detection: idle entry → reset state variables
    if (idleNow && !idleWasActive) {
      isMouseIdle = false;
      hasTriggeredYawn = false;
      idleLookPlayed = false;
      lastCursorX = null;
      lastCursorY = null;
      mouseStillSince = Date.now();
      lastEyeDx = 0;
      lastEyeDy = 0;
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }

    // Edge detection: idle exit → clear pending timers
    // (variable resets not needed here — idle entry will overwrite them all)
    if (!idleNow && idleWasActive) {
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }
    idleWasActive = idleNow;

    if (!idleNow && !miniIdleNow) return;

    // ── Below: idle or mini-idle logic ──
    const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
    lastCursorX = cursor.x;
    lastCursorY = cursor.y;

    // Normal idle: mouse idle detection + sleep sequence
    if (idleNow) {
      if (moved) {
        mouseStillSince = Date.now();
        hasTriggeredYawn = false;
        idleLookPlayed = false;
        if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
        if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
        if (isMouseIdle) {
          isMouseIdle = false;
          sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
        }
      }

      const elapsed = Date.now() - mouseStillSince;

      // 60s no mouse movement → yawning → dozing
      if (!hasTriggeredYawn && elapsed >= MOUSE_SLEEP_TIMEOUT) {
        hasTriggeredYawn = true;
        if (!isMouseIdle) sendToRenderer("eye-move", 0, 0);
        yawnDelayTimer = setTimeout(() => {
          yawnDelayTimer = null;
          if (currentState === "idle") setState("yawning");
        }, isMouseIdle ? 50 : 250);
        return;
      }

      // 20s no mouse movement → idle-look (play once, then return)
      if (!isMouseIdle && !hasTriggeredYawn && !idleLookPlayed && elapsed >= MOUSE_IDLE_TIMEOUT) {
        isMouseIdle = true;
        idleLookPlayed = true;
        sendToRenderer("eye-move", 0, 0);
        setTimeout(() => {
          if (isMouseIdle && currentState === "idle") {
            sendToRenderer("state-change", "idle", SVG_IDLE_LOOK);
          }
        }, 250);
        idleLookReturnTimer = setTimeout(() => {
          idleLookReturnTimer = null;
          if (isMouseIdle && currentState === "idle") {
            isMouseIdle = false;
            sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
            setTimeout(() => { forceEyeResend = true; }, 200);
          }
        }, 250 + IDLE_LOOK_DURATION);
        return;
      }

      // Only send eye position when showing idle-follow
      if (isMouseIdle || (!moved && !forceEyeResend)) return;
    } else {
      // miniIdleNow: skip sleep detection, eye tracking only
      if (!moved && !forceEyeResend) return;
    }

    // ── Eye position calculation (shared by idle and mini-idle) ──
    const skipDedup = forceEyeResend;
    forceEyeResend = false;

    const obj = getObjRect(bounds);
    const eyeScreenX = obj.x + obj.w * (22 / 45);
    const eyeScreenY = obj.y + obj.h * (34 / 45);

    const relX = cursor.x - eyeScreenX;
    const relY = cursor.y - eyeScreenY;

    const MAX_OFFSET = 3;
    const dist = Math.sqrt(relX * relX + relY * relY);
    let eyeDx = 0, eyeDy = 0;
    if (dist > 1) {
      const scale = Math.min(1, dist / 300);
      eyeDx = (relX / dist) * MAX_OFFSET * scale;
      eyeDy = (relY / dist) * MAX_OFFSET * scale;
    }

    eyeDx = Math.round(eyeDx * 2) / 2;
    eyeDy = Math.round(eyeDy * 2) / 2;
    eyeDy = Math.max(-1.5, Math.min(1.5, eyeDy));

    if (skipDedup || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
      lastEyeDx = eyeDx;
      lastEyeDy = eyeDy;
      sendToRenderer("eye-move", eyeDx, eyeDy);
    }
  }, 50); // ~20fps — hit-test needs faster response than 67ms eye tracking
}

// ── Wake poll (detect mouse movement during dozing → wake up) ──
function startWakePoll() {
  if (wakePollTimer) return;
  const cursor = screen.getCursorScreenPoint();
  lastWakeCursorX = cursor.x;
  lastWakeCursorY = cursor.y;

  wakePollTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint();
    const moved = cursor.x !== lastWakeCursorX || cursor.y !== lastWakeCursorY;

    if (moved) {
      stopWakePoll();
      wakeFromDoze();
      return;
    }

    // 10min total mouse idle → deep sleep (only from dozing, not sleeping)
    if (currentState === "dozing" && Date.now() - mouseStillSince >= DEEP_SLEEP_TIMEOUT) {
      stopWakePoll();
      applyState("collapsing");
    }
  }, 200); // 5 checks/sec, lightweight
}

function stopWakePoll() {
  if (wakePollTimer) { clearInterval(wakePollTimer); wakePollTimer = null; }
}

function wakeFromDoze() {
  if (currentState === "sleeping" || currentState === "collapsing") {
    applyState("waking");
    return;
  }
  sendToRenderer("wake-from-doze");
  // After eye-opening transition, switch to idle
  setTimeout(() => {
    if (currentState === "dozing") {
      applyState("idle");
    }
  }, 350);
}

// ── Session management ──
const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

function updateSession(sessionId, state, event) {
  if (event === "SessionEnd") {
    sessions.delete(sessionId);
  } else if (state === "attention" || SLEEP_SEQUENCE.has(state)) {
    // Stop/sleep: response complete → session goes idle
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now() });
  } else if (ONESHOT_STATES.has(state)) {
    // Other oneshots (error/sweeping/notification/carrying):
    // preserve session's previous state so auto-return resolves correctly
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now() });
    }
  } else {
    // Preserve juggling: subagent's own tool use (PreToolUse/PostToolUse)
    // shouldn't override juggling — only SubagentStop should end it.
    const existing = sessions.get(sessionId);
    if (existing && existing.state === "juggling" && state === "working" && event !== "SubagentStop") {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state, updatedAt: Date.now() });
    }
  }
  cleanStaleSessions();

  // All sessions ended → sleep immediately
  if (sessions.size === 0 && event === "SessionEnd") {
    setState("sleeping");
    return;
  }

  // Oneshot: show animation directly, auto-return will re-resolve from session map
  if (ONESHOT_STATES.has(state)) {
    setState(state);
    return;
  }

  const displayState = resolveDisplayState();
  setState(displayState, getSvgOverride(displayState));
}

let staleCleanupTimer = null;

function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_STALE_MS) { sessions.delete(id); changed = true; }
  }
  // If stale sessions were cleaned, re-resolve display state
  if (changed && sessions.size === 0) {
    setState("yawning");
  } else if (changed) {
    const resolved = resolveDisplayState();
    setState(resolved, getSvgOverride(resolved));
  }
}

function startStaleCleanup() {
  if (staleCleanupTimer) return;
  staleCleanupTimer = setInterval(cleanStaleSessions, 60000); // every 60s
}

function stopStaleCleanup() {
  if (staleCleanupTimer) { clearInterval(staleCleanupTimer); staleCleanupTimer = null; }
}

function resolveDisplayState() {
  if (sessions.size === 0) return "idle";
  let best = "sleeping";
  for (const [, s] of sessions) {
    if ((STATE_PRIORITY[s.state] || 0) > (STATE_PRIORITY[best] || 0)) best = s.state;
  }
  return best;
}

function getActiveWorkingCount() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "working" || s.state === "thinking" || s.state === "juggling") n++;
  }
  return n;
}

function getWorkingSvg() {
  const n = getActiveWorkingCount();
  if (n >= 3) return "clawd-working-building.svg";
  if (n >= 2) return "clawd-working-juggling.svg";
  return "clawd-working-typing.svg";
}

function getSvgOverride(state) {
  if (state === "working") return getWorkingSvg();
  if (state === "juggling") return getJugglingSvg();
  return null;
}

function getJugglingSvg() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "juggling") n++;
  }
  return n >= 2 ? "clawd-working-conducting.svg" : "clawd-working-juggling.svg";
}

// ── Do Not Disturb ──
function enableDoNotDisturb() {
  if (doNotDisturb) return;
  doNotDisturb = true;
  sendToRenderer("dnd-change", true);
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  stopWakePoll();
  if (miniMode) {
    applyState("mini-sleep");
  } else {
    applyState("yawning");  // walk through yawning → collapsing → sleeping
  }
  buildContextMenu();
  buildTrayMenu();
}

function disableDoNotDisturb() {
  if (!doNotDisturb) return;
  doNotDisturb = false;
  sendToRenderer("dnd-change", false);
  if (miniMode) {
    if (miniSleepPeeked) { miniPeekOut(); miniSleepPeeked = false; }
    applyState("mini-idle");
  } else {
    applyState("waking");
  }
  buildContextMenu();
  buildTrayMenu();
}

// ── HTTP server ──
let httpServer = null;

function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/debug/state") {
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        try {
          const data = JSON.parse(body || "{}");
          const state = String(data.state || "");
          const svg = data.svg ? path.basename(String(data.svg)) : undefined;
          if (!STATE_SVGS[state] && !svg) {
            res.writeHead(400);
            res.end("unknown state");
            return;
          }
          setState(state || "idle", svg);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, state, svg: svg || null }));
        } catch (error) {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else if (req.method === "POST" && req.url === "/state") {
      let body = "";
      let bodySize = 0;
      let destroyed = false;
      req.on("data", (chunk) => {
        bodySize += chunk.length;
        if (bodySize > 1024) { destroyed = true; req.destroy(); return; }
        body += chunk;
      });
      req.on("end", () => {
        if (destroyed) return;
        try {
          const data = JSON.parse(body);
          const { state, svg, session_id, event } = data;
          if (STATE_SVGS[state]) {
            const sid = session_id || "default";
            // mini-* states are internal — only allow via direct SVG override (test scripts)
            if (state.startsWith("mini-") && !svg) {
              res.writeHead(400);
              res.end("mini states require svg override");
              return;
            }
            if (svg) {
              // Direct SVG override (test-demo.sh, manual curl) — bypass session logic
              // Sanitize: strip path separators to prevent directory traversal
              const safeSvg = path.basename(svg);
              setState(state, safeSvg);
            } else {
              updateSession(sid, state, event);
            }
            res.writeHead(200);
            res.end("ok");
          } else {
            res.writeHead(400);
            res.end("unknown state");
          }
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(23333, "127.0.0.1", () => {
    console.log("Clawd state server listening on 127.0.0.1:23333");
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn("Port 23333 is in use — running in idle-only mode (no state sync)");
    } else {
      console.error("HTTP server error:", err.message);
    }
  });
}

// ── System tray ──
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "../assets/tray-icon.png")).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip("Clawd Desktop Pet");
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: doNotDisturb ? t("wake") : t("sleep"),
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    {
      label: t("startOnLogin"),
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: t("language"),
      submenu: [
        { label: "English", type: "radio", checked: lang === "en", click: () => setLanguage("en") },
        { label: "中文", type: "radio", checked: lang === "zh", click: () => setLanguage("zh") },
      ],
    },
    { type: "separator" },
    { label: t("quit"), click: () => requestAppQuit() },
  ]);
  tray.setContextMenu(menu);
}

// ── Window creation ──
function requestAppQuit() {
  isQuitting = true;
  app.quit();
}

function ensureContextMenuOwner() {
  if (contextMenuOwner && !contextMenuOwner.isDestroyed()) return contextMenuOwner;
  if (!win || win.isDestroyed()) return null;

  contextMenuOwner = new BrowserWindow({
    parent: win,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    closable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
  });

  contextMenuOwner.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      contextMenuOwner.hide();
    }
  });

  contextMenuOwner.on("closed", () => {
    contextMenuOwner = null;
  });

  return contextMenuOwner;
}

function showPetContextMenu() {
  if (!win || win.isDestroyed()) return;
  if (menuOpen) return;

  buildContextMenu();
  const owner = ensureContextMenuOwner();
  if (!owner) return;

  const cursor = screen.getCursorScreenPoint();
  owner.setBounds({ x: cursor.x, y: cursor.y, width: 1, height: 1 });
  owner.show();
  owner.focus();

  menuOpen = true;
  contextMenu.popup({
    window: owner,
    callback: () => {
      menuOpen = false;
      if (owner && !owner.isDestroyed()) owner.hide();
      if (win && !win.isDestroyed()) {
        win.showInactive();
        win.moveTop();
      }
    },
  });
}

function createWindow() {
  const prefs = loadPrefs();
  if (prefs && SIZES[prefs.size]) currentSize = prefs.size;
  if (prefs && i18n[prefs.lang]) lang = prefs.lang;
  const size = SIZES[currentSize];

  // Restore saved position, or default to bottom-right of primary display
  let startX, startY;
  if (prefs && prefs.miniMode) {
    // Restore mini mode
    preMiniX = prefs.preMiniX || 0;
    preMiniY = prefs.preMiniY || 0;
    const wa = getNearestWorkArea(prefs.x + size.width / 2, prefs.y + size.height / 2);
    currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
    startX = currentMiniX;
    startY = Math.max(wa.y, Math.min(prefs.y, wa.y + wa.height - size.height));
    miniSnap = { y: startY, width: size.width, height: size.height };
    miniMode = true;
  } else if (prefs) {
    const clamped = clampToScreen(prefs.x, prefs.y, size.width, size.height);
    startX = clamped.x;
    startY = clamped.y;
  } else {
    const { workArea } = screen.getPrimaryDisplay();
    startX = workArea.x + workArea.width - size.width - 20;
    startY = workArea.y + workArea.height - size.height - 20;
  }

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.setFocusable(false);
  win.loadFile(path.join(__dirname, "index.html"));
  win.showInactive();

  buildContextMenu();
  createTray();
  ensureContextMenuOwner();

  ipcMain.on("show-context-menu", showPetContextMenu);

  ipcMain.on("move-window-by", (event, dx, dy) => {
    if (miniMode || miniTransitioning) return;
    const { x, y } = win.getBounds();
    const size = SIZES[currentSize];
    const clamped = clampToScreen(x + dx, y + dy, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
  });

  ipcMain.on("pause-cursor-polling", () => { idlePaused = true; });
  ipcMain.on("resume-from-reaction", () => {
    idlePaused = false;
    // Skip re-send during mini transition (drag-end fires next and will set the right state)
    if (miniTransitioning) return;
    // Re-send current state to renderer without resetting stateChangedAt or timers.
    sendToRenderer("state-change", currentState, currentSvg);
  });

  ipcMain.on("drag-lock", (event, locked) => {
    dragLocked = !!locked;
    if (locked && !mouseOverPet) {
      mouseOverPet = true;
      win.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on("drag-end", () => {
    if (!miniMode && !miniTransitioning) {
      checkMiniModeSnap();
    }
  });

  ipcMain.on("exit-mini-mode", () => {
    if (miniMode) exitMiniMode();
  });

  ipcMain.on("clawd-chat-focus", (_event, focused) => {
    if (!win || win.isDestroyed()) return;
    win.setFocusable(!!focused);
    if (focused) {
      win.focus();
      win.setIgnoreMouseEvents(false);
    } else {
      win.blur();
      win.setFocusable(false);
    }
  });

  ipcMain.on("clawd-open-controls", () => {
    openControlsWindow();
  });

  ipcMain.handle("clawd-speak", async (_event, { text, voice }) => {
    debugLog("clawd-speak:start", { textLength: String(text || "").trim().length, voice: voice || bridgeState.voice || DEFAULT_TTS_VOICE });
    const result = await speakText(text, voice || bridgeState.voice || DEFAULT_TTS_VOICE);
    debugLog("clawd-speak:tts-result", result);
    if (result?.audioPath) {
      const playback = await playAudioFile(result.audioPath);
      debugLog("clawd-speak:playback-result", playback);
      return { ...result, playback };
    }
    return result;
  });

  ipcMain.handle("clawd-preview-reply", async (_event, { text }) => {
    const cleanText = String(text || "").trim();
    debugLog("clawd-preview-reply:start", {
      textLength: cleanText.length,
      textPreview: cleanText.slice(0, 80),
      bridgeEnabled: !!bridgeState.enabled,
      bridgeUrl: bridgeState.bridgeUrl || null,
      sessionKey: bridgeState.sessionKey || null,
    });
    triggerCompanionState("thinking");
    if (bridgeState.enabled && bridgeState.bridgeUrl) {
      try {
        const ensured = await ensureBridgeRunning();
        debugLog("clawd-preview-reply:bridge-ensure", ensured);
        if (!ensured?.ok) throw new Error(ensured?.error || ensured?.reason || "bridge_not_ready");
        debugLog("clawd-preview-reply:bridge-request", { bridgeUrl: bridgeState.bridgeUrl, sessionKey: bridgeState.sessionKey || null });
        const result = await postJson(bridgeState.bridgeUrl, { text: cleanText, sessionKey: bridgeState.sessionKey });
        debugLog("clawd-preview-reply:bridge-result", result);
        const connected = !!result?.ok;
        bridgeLastHealth = { ok: connected, checkedAt: Date.now(), data: result };
        if (connected) {
          try {
            triggerCompanionState(chooseReplyState(result?.reply || ""));
          } catch (stateError) {
            debugLog("clawd-preview-reply:state-error", stateError?.message || String(stateError));
            triggerCompanionState("attention");
          }
        }
        return {
          ok: !!result?.ok,
          reply: result?.reply || "我在呢。",
          mode: connected ? "dedicated-session" : "preview-fallback",
          connected,
          sessionKey: bridgeState.sessionKey || null,
        };
      } catch (error) {
        debugLog("clawd-preview-reply:bridge-error", error?.message || String(error));
        bridgeLastHealth = { ok: false, checkedAt: Date.now(), error: error?.message || String(error) };
        triggerCompanionState("error");
        return { ok: false, reply: `专用会话桥暂时没接好，我先陪着你。${buildPreviewReply(cleanText)}`, mode: "preview-fallback", connected: false, sessionKey: bridgeState.sessionKey || null, error: error.message };
      }
    }
    const reply = buildPreviewReply(cleanText);
    debugLog("clawd-preview-reply:preview-result", { reply });
    triggerCompanionState("attention");
    return { ok: true, reply, mode: bridgeState.mode || "preview", connected: false, sessionKey: bridgeState.sessionKey || null };
  });

  ipcMain.handle("clawd-transcribe-audio", async (_event, { audioPath }) => {
    try {
      const result = await runNodeTtsScript("transcribe-audio.js", audioPath);
      return { ok: true, text: result.text || "", outPath: result.outPath || null };
    } catch (error) {
      return { ok: false, error: error.message || "transcribe_failed" };
    }
  });

  ipcMain.handle("clawd-transcribe-audio-buffer", async (_event, { buffer, extension }) => {
    try {
      const ext = String(extension || "webm").replace(/[^a-z0-9]/gi, "") || "webm";
      const audioPath = path.join(os.tmpdir(), `clawd-voice-${Date.now()}.${ext}`);
      const raw = Buffer.from(String(buffer || ""), "base64");
      fs.writeFileSync(audioPath, raw);
      if (!raw.length) return { ok: false, error: "empty_audio_buffer", audioPath };
      const result = await runNodeTtsScript("transcribe-audio.js", audioPath);
      return { ok: true, text: result.text || "", outPath: result.outPath || null, audioPath };
    } catch (error) {
      return { ok: false, error: error.message || "transcribe_buffer_failed" };
    }
  });

  ipcMain.handle("clawd-bridge-status", async () => {
    if (bridgeState.enabled) {
      await checkBridgeHealth(3000);
    }
    return getBridgeStatusSnapshot();
  });

  ipcMain.handle("clawd-renderer-log", async (_event, payload) => {
    try {
      const line = `[${new Date().toISOString()}] ${JSON.stringify(payload)}\n`;
      fs.appendFileSync(RENDERER_DEBUG_LOG, line, "utf8");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'renderer_log_failed' };
    }
  });

  ipcMain.handle("clawd-set-bridge-mode", async (_event, { enabled, sessionKey, bridgeUrl, voice }) => {
    bridgeState = {
      enabled: !!enabled,
      mode: enabled ? "dedicated-session-pending" : "preview",
      sessionKey: sessionKey || bridgeState.sessionKey || "agent:main:chat-clawd",
      bridgeUrl: bridgeUrl || bridgeState.bridgeUrl || DEFAULT_BRIDGE_URL,
      voice: voice || bridgeState.voice || DEFAULT_TTS_VOICE,
      updatedAt: Date.now(),
    };
    saveBridgeState(bridgeState);
    if (bridgeState.enabled) {
      await ensureBridgeRunning();
    } else {
      stopBridgeProcess();
      bridgeLastHealth = { ok: false, checkedAt: Date.now(), error: "bridge_disabled" };
    }
    return getBridgeStatusSnapshot();
  });

  ipcMain.handle("clawd-toggle-ambient", async () => {
    try {
      const result = await runNodeTtsScript("ambient-player.js", "toggle");
      return result;
    } catch (error) {
      return { ok: false, error: error.message || "ambient_toggle_failed" };
    }
  });

  ipcMain.handle("clawd-run-coding-task", async (_event, { text, cwd: taskCwd }) => {
    const cleanText = String(text || "").trim();
    if (!cleanText) return { ok: false, error: "empty_task" };
    const workDir = taskCwd || bridgeState.codingCwd || os.homedir();
    const agentScript = path.join(V2_ROOT, "claude-code-agent.mjs");
    triggerCompanionState("working");
    return new Promise((resolve) => {
      execFile("node", [agentScript, cleanText, workDir], {
        cwd: V2_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 16, timeout: 300000, env: { ...process.env },
      }, (error, stdout, stderr) => {
        if (error && !stdout) {
          triggerCompanionState("error");
          resolve({ ok: false, error: (stderr || error.message || "agent_failed").slice(0, 200) });
          return;
        }
        triggerCompanionState("attention");
        try {
          const parsed = JSON.parse(stdout || "{}");
          resolve(parsed?.ok ? parsed : { ok: true, output: stdout || "", stderr: stderr || "" });
        } catch {
          resolve({ ok: true, output: stdout || "", stderr: stderr || "" });
        }
      });
    });
  });

  startMainTick();
  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-finish-load", () => {
    if (miniMode) {
      sendToRenderer("mini-mode-change", true);
    }
    if (doNotDisturb) {
      sendToRenderer("dnd-change", true);
      if (miniMode) {
        applyState("mini-sleep");
      } else {
        applyState("sleeping");
      }
    } else if (miniMode) {
      applyState("mini-idle");
    } else if (sessions.size > 0) {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    } else {
      applyState("idle");
    }
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer crashed:", details.reason);
    dragLocked = false;
    idlePaused = false;
    mouseOverPet = false;
    win.setIgnoreMouseEvents(true);
    win.webContents.reload();
  });

  // ── Periodic alwaysOnTop refresh (Windows DWM can drop z-order) ──
  // Use moveTop() instead of setAlwaysOnTop(false→true) to avoid a brief
  // gap where the window loses TOPMOST status — that gap lets other windows
  // slip above Clawd during window switches.
  moveTopTimer = setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.moveTop();
    }
  }, 30000); // every 30s

  // ── Display change: re-clamp window to prevent off-screen ──
  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed()) return;
    if (miniMode) {
      const size = SIZES[currentSize];
      const snapY = miniSnap ? miniSnap.y : win.getBounds().y;
      const wa = getNearestWorkArea(currentMiniX + size.width / 2, snapY + size.height / 2);
      currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
      const clampedY = Math.max(wa.y, Math.min(snapY, wa.y + wa.height - size.height));
      miniSnap = { y: clampedY, width: size.width, height: size.height };
      win.setBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height });
      return;
    }
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    if (clamped.x !== x || clamped.y !== y) {
      win.setBounds({ ...clamped, width, height });
    }
  });
  screen.on("display-removed", () => {
    if (!win || win.isDestroyed()) return;
    if (miniMode) {
      exitMiniMode();
      return;
    }
    const { x, y, width, height } = win.getBounds();
    const clamped = clampToScreen(x, y, width, height);
    win.setBounds({ ...clamped, width, height });
  });
}

function getNearestWorkArea(cx, cy) {
  const displays = screen.getAllDisplays();
  let nearest = displays[0].workArea;
  let minDist = Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    if (dist < minDist) { minDist = dist; nearest = wa; }
  }
  return nearest;
}

function clampToScreen(x, y, w, h) {
  const nearest = getNearestWorkArea(x + w / 2, y + h / 2);
  const mLeft  = Math.round(w * 0.25);
  const mRight = Math.round(w * 0.25);
  const mTop   = Math.round(h * 0.6);
  const mBot   = Math.round(h * 0.04);
  return {
    x: Math.max(nearest.x - mLeft, Math.min(x, nearest.x + nearest.width - w + mRight)),
    y: Math.max(nearest.y - mTop,  Math.min(y, nearest.y + nearest.height - h + mBot)),
  };
}

// ── Window animation ──
function animateWindowX(targetX, durationMs) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = win.getBounds();
  const startX = bounds.x;
  if (startX === targetX) { isAnimating = false; return; }
  isAnimating = true;
  const startTime = Date.now();
  // Use miniSnap to lock y/width/height and prevent DPI drift accumulation
  const snapY = miniSnap ? miniSnap.y : bounds.y;
  const snapW = miniSnap ? miniSnap.width : bounds.width;
  const snapH = miniSnap ? miniSnap.height : bounds.height;
  const step = () => {
    if (!win || win.isDestroyed()) { peekAnimTimer = null; isAnimating = false; return; }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    win.setBounds({ x, y: snapY, width: snapW, height: snapH });
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
    }
  };
  step();
}

function animateWindowParabola(targetX, targetY, durationMs, onDone) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = win.getBounds();
  const startX = bounds.x, startY = bounds.y;
  const size = SIZES[currentSize];
  if (startX === targetX && startY === targetY) {
    isAnimating = false;
    if (onDone) onDone();
    return;
  }
  isAnimating = true;
  const startTime = Date.now();
  const step = () => {
    if (!win || win.isDestroyed()) { peekAnimTimer = null; isAnimating = false; return; }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    const arc = -4 * JUMP_PEAK_HEIGHT * t * (t - 1);
    const y = Math.round(startY + (targetY - startY) * eased - arc);
    win.setPosition(x, y);
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
    }
  };
  step();
}

// ── Mini Mode functions ──
function miniPeekIn() {
  animateWindowX(currentMiniX - PEEK_OFFSET, 200);
}

function miniPeekOut() {
  animateWindowX(currentMiniX, 200);
}

function cancelMiniTransition() {
  miniTransitioning = false;
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
}

function checkMiniModeSnap() {
  if (miniMode) return;
  const bounds = win.getBounds();
  const size = SIZES[currentSize];
  const mRight = Math.round(size.width * 0.25);
  // Check against ALL monitors' right edges, but only if window center is on that monitor
  const centerX = bounds.x + size.width / 2;
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    const centerY = bounds.y + size.height / 2;
    if (centerX < wa.x || centerX > wa.x + wa.width) continue;
    if (centerY < wa.y || centerY > wa.y + wa.height) continue;
    const rightLimit = wa.x + wa.width - size.width + mRight;
    if (bounds.x >= rightLimit - SNAP_TOLERANCE) {
      enterMiniMode(wa);
      return;
    }
  }
}

function enterMiniMode(wa, viaMenu) {
  if (miniMode && !viaMenu) return; // Already in mini mode
  const bounds = win.getBounds();
  if (!viaMenu) {
    preMiniX = bounds.x;
    preMiniY = bounds.y;
  }
  miniMode = true;
  const size = SIZES[currentSize];
  currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
  miniSnap = { y: bounds.y, width: size.width, height: size.height };

  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }
  stopWakePoll();

  sendToRenderer("mini-mode-change", true);
  miniTransitioning = true;
  buildContextMenu();
  buildTrayMenu();

  const enterSvgState = doNotDisturb ? "mini-enter-sleep" : "mini-enter";

  if (viaMenu) {
    // Jump past ALL screens, load enter SVG off-screen, then slide to mini position
    const displays = screen.getAllDisplays();
    let maxRight = 0;
    for (const d of displays) maxRight = Math.max(maxRight, d.bounds.x + d.bounds.width);
    const jumpTarget = maxRight;
    animateWindowParabola(jumpTarget, bounds.y, JUMP_DURATION, () => {
      // Window is past all screens — load enter SVG here (invisible)
      applyState(enterSvgState);
      miniTransitionTimer = setTimeout(() => {
        // SVG is loaded, now move to mini position (enter animation already playing)
        miniSnap = { y: bounds.y, width: size.width, height: size.height };
        win.setBounds({ x: currentMiniX, y: miniSnap.y, width: miniSnap.width, height: miniSnap.height });
        miniTransitionTimer = setTimeout(() => {
          miniTransitioning = false;
          applyState(doNotDisturb ? "mini-sleep" : "mini-idle");
        }, 3200);
      }, 300);
    });
  } else {
    // Drag entry: fast slide + immediate enter animation (no idle hiccup)
    animateWindowX(currentMiniX, 100);
    applyState(enterSvgState);
    miniTransitionTimer = setTimeout(() => {
      miniTransitioning = false;
      applyState(doNotDisturb ? "mini-sleep" : "mini-idle");
    }, 3200);
  }
}

function exitMiniMode() {
  if (!miniMode) return;
  cancelMiniTransition();
  miniMode = false;
  miniSnap = null;
  miniSleepPeeked = false;
  sendToRenderer("mini-mode-change", false);
  buildContextMenu();
  buildTrayMenu();

  const size = SIZES[currentSize];
  const clamped = clampToScreen(preMiniX, preMiniY, size.width, size.height);
  const wa = getNearestWorkArea(clamped.x + size.width / 2, clamped.y + size.height / 2);
  const mRight = Math.round(size.width * 0.25);
  if (clamped.x >= wa.x + wa.width - size.width + mRight - SNAP_TOLERANCE) {
    clamped.x = wa.x + wa.width - size.width + mRight - 100;
  }

  // Clear any lingering mini state timers
  if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingState = null; }

  animateWindowParabola(clamped.x, clamped.y, JUMP_DURATION, () => {
    // Use applyState directly — bypass MIN_DISPLAY_MS so mini animations don't linger
    if (doNotDisturb) {
      doNotDisturb = false;
      sendToRenderer("dnd-change", false);
      buildContextMenu();
      buildTrayMenu();
      applyState("waking");
    } else {
      const resolved = resolveDisplayState();
      applyState(resolved, getSvgOverride(resolved));
    }
  });
}

function enterMiniViaMenu() {
  const bounds = win.getBounds();
  const size = SIZES[currentSize];
  const wa = getNearestWorkArea(bounds.x + size.width / 2, bounds.y + size.height / 2);

  preMiniX = bounds.x;
  preMiniY = bounds.y;
  miniTransitioning = true;

  // Tell renderer early so it blocks drag during crabwalk
  sendToRenderer("mini-mode-change", true);

  applyState("mini-crabwalk");

  const edgeX = wa.x + wa.width - size.width + Math.round(size.width * 0.25);
  const walkDist = Math.abs(bounds.x - edgeX);
  const walkDuration = walkDist / CRABWALK_SPEED;
  animateWindowX(edgeX, walkDuration);

  miniTransitionTimer = setTimeout(() => {
    enterMiniMode(wa, true);
  }, walkDuration + 50);
}

function buildContextMenu() {
  const template = [
    {
      label: t("size"),
      submenu: [
        { label: t("small"), type: "radio", checked: currentSize === "S", click: () => resizeWindow("S") },
        { label: t("medium"), type: "radio", checked: currentSize === "M", click: () => resizeWindow("M") },
        { label: t("large"), type: "radio", checked: currentSize === "L", click: () => resizeWindow("L") },
      ],
    },
    { type: "separator" },
    {
      label: miniMode ? t("exitMiniMode") : t("miniMode"),
      enabled: !miniTransitioning && !(doNotDisturb && !miniMode),
      click: () => miniMode ? exitMiniMode() : enterMiniViaMenu(),
    },
    { type: "separator" },
    {
      label: doNotDisturb ? t("wake") : t("sleep"),
      click: () => doNotDisturb ? disableDoNotDisturb() : enableDoNotDisturb(),
    },
    { type: "separator" },
    {
      label: t("language"),
      submenu: [
        { label: "English", type: "radio", checked: lang === "en", click: () => setLanguage("en") },
        { label: "中文", type: "radio", checked: lang === "zh", click: () => setLanguage("zh") },
      ],
    },
    { type: "separator" },
    { label: t("quit"), click: () => requestAppQuit() },
  ];
  contextMenu = Menu.buildFromTemplate(template);
}

function setLanguage(newLang) {
  lang = newLang;
  buildContextMenu();
  buildTrayMenu();
  savePrefs();
}

function resizeWindow(sizeKey) {
  currentSize = sizeKey;
  const size = SIZES[sizeKey];
  if (miniMode) {
    const { y } = win.getBounds();
    const wa = getNearestWorkArea(currentMiniX + size.width / 2, y + size.height / 2);
    currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
    const clampedY = Math.max(wa.y, Math.min(y, wa.y + wa.height - size.height));
    miniSnap = { y: clampedY, width: size.width, height: size.height };
    win.setBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height });
  } else {
    const { x, y } = win.getBounds();
    const clamped = clampToScreen(x, y, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
  }
  buildContextMenu();
  savePrefs();
}

// ── Single instance lock ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) win.showInactive();
  });

  app.whenReady().then(createWindow);

  app.on("before-quit", () => {
    isQuitting = true;
    savePrefs();
    if (pendingTimer) clearTimeout(pendingTimer);
    if (autoReturnTimer) clearTimeout(autoReturnTimer);
    if (mainTickTimer) clearInterval(mainTickTimer);
    if (wakePollTimer) clearInterval(wakePollTimer);
    if (miniTransitionTimer) clearTimeout(miniTransitionTimer);
    if (peekAnimTimer) clearTimeout(peekAnimTimer);
    if (moveTopTimer) clearInterval(moveTopTimer);
    if (yawnDelayTimer) clearTimeout(yawnDelayTimer);
    if (idleLookReturnTimer) clearTimeout(idleLookReturnTimer);
    stopStaleCleanup();
    if (httpServer) httpServer.close();
    stopBridgeProcess();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
