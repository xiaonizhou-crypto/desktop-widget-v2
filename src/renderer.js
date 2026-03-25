// --- Pointer-based drag + click detection (with Pointer Capture for safety) ---
const container = document.getElementById("pet-container");
const PET_INTERACT_WIDTH_RATIO = 0.62;

const chatToggle = document.getElementById("chat-toggle");
const chatBubble = document.getElementById("chat-bubble");
const chatPanel = document.getElementById("chat-panel");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatVoice = document.getElementById("chat-voice");
const chatCode = document.getElementById("chat-code");
const statusDot = document.getElementById("status-dot");
let panelOpen = false;

function refreshBridgeUI(connected) {
  container.classList.toggle("bridge-on", !!connected);
  if (statusDot) statusDot.title = connected ? "已连接专用会话" : "当前是预览模式";
}

async function syncBridgeStatus() {
  try {
    const status = await window.clawdVoice.bridgeStatus();
    refreshBridgeUI(!!status?.enabled);
  } catch {
    refreshBridgeUI(false);
  }
}


function setPanelOpen(next) {
  panelOpen = next;
  container.classList.toggle("panel-open", panelOpen);
  window.electronAPI.setChatFocus(panelOpen);
  if (panelOpen) {
    setTimeout(() => chatInput.focus(), 30);
    setTimeout(() => chatInput.focus(), 120);
  }
}

function showBubble(text, ms = 1600) {
  chatBubble.textContent = String(text || "").trim();
  chatBubble.classList.add("show");
  clearTimeout(showBubble._t);
  showBubble._t = setTimeout(() => chatBubble.classList.remove("show"), ms);
}

function debugLog(...args) {
  console.log("[clawd-v2][renderer]", ...args);
  try {
    const [event, data] = args;
    window.clawdVoice?.debugLog?.(String(event || 'renderer-log'), typeof data === 'object' ? data : { value: data ?? null });
  } catch {}
}

let chatRequestInFlight = false;
let mediaRecorder = null;
let mediaStream = null;
let mediaChunks = [];
let recording = false;

async function runCodingPrompt() {
  const text = String(chatInput.value || "").trim().replace(/^\/code\s*/i, "");
  if (!text || chatRequestInFlight) return;
  chatRequestInFlight = true;
  if (chatSend) chatSend.disabled = true;
  if (chatInput) chatInput.disabled = true;
  if (chatCode) chatCode.disabled = true;
  chatInput.value = "";
  showBubble("coding中...", 1200);
  try {
    const result = await window.clawdVoice.runCodingTask(text);
    debugLog("runCodingPrompt:result", result);
    const reply = String(result?.output || result?.summary || result?.stderr || result?.error || "搞定了").trim().slice(0, 180);
    showBubble(reply || "搞定了", 3200);
  } catch (error) {
    debugLog("runCodingPrompt:error", error?.message || String(error));
    showBubble("coding没接好", 1800);
  } finally {
    chatRequestInFlight = false;
    if (chatSend) chatSend.disabled = false;
    if (chatInput) chatInput.disabled = false;
    if (chatCode) chatCode.disabled = false;
  }
}

async function toggleVoiceRecording() {
  if (chatRequestInFlight) return;
  if (recording && mediaRecorder) {
    if (recordingStopTimer) {
      clearTimeout(recordingStopTimer);
      recordingStopTimer = null;
    }
    mediaRecorder.stop();
    showBubble("收到，正在转写…", 1400);
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mediaChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      recording = false;
      if (recordingStopTimer) {
        clearTimeout(recordingStopTimer);
        recordingStopTimer = null;
      }
      if (chatVoice) {
        chatVoice.classList.remove("recording");
        chatVoice.textContent = "🎙";
      }
      try {
        const blob = new Blob(mediaChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        showBubble("我在转写…", 1200);
        const transcribed = await window.clawdVoice.transcribeAudioBuffer(base64, "webm");
        debugLog("toggleVoiceRecording:transcribed", transcribed);
        const text = String(transcribed?.text || "").trim();
        if (text) {
          showBubble(text, 1600);
          chatInput.value = text;
          await sendChatPrompt();
        } else {
          showBubble("没听清，再说一次", 1800);
        }
      } catch (error) {
        debugLog("toggleVoiceRecording:error", error?.message || String(error));
        showBubble("录音没接好", 1800);
      } finally {
        if (mediaStream) {
          mediaStream.getTracks().forEach((t) => t.stop());
          mediaStream = null;
        }
        mediaRecorder = null;
        mediaChunks = [];
      }
    };
    mediaRecorder.start();
    recording = true;
    if (chatVoice) {
      chatVoice.classList.add("recording");
      chatVoice.textContent = "■";
    }
    showBubble("在听，点一下结束", 1400);
    recordingStopTimer = setTimeout(() => {
      if (recording && mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }, MAX_RECORDING_MS);
  } catch (error) {
    debugLog("toggleVoiceRecording:start:error", error?.message || String(error));
    showBubble("麦克风没开", 1800);
  }
}

async function sendChatPrompt() {
  const text = String(chatInput.value || "").trim();
  if (!text || chatRequestInFlight) return;
  chatRequestInFlight = true;
  if (chatSend) chatSend.disabled = true;
  if (chatInput) chatInput.disabled = true;
  debugLog("sendChatPrompt:start", { textLength: text.length, textPreview: text.slice(0, 40) });
  chatInput.value = "";

  showBubble("收到中...", 900);
  try {
    const result = await window.clawdVoice.previewReply(text);
    debugLog("sendChatPrompt:previewReply:result", result);
    refreshBridgeUI(!!result?.connected);
    showBubble(result?.reply || "我在呢。", 2600);
    if (result?.reply) {
      try {
        debugLog("sendChatPrompt:speak:start", { replyLength: result.reply.length, mode: result?.mode, connected: !!result?.connected });
        const speakResult = await window.clawdVoice.speak(result.reply);
        debugLog("sendChatPrompt:speak:result", speakResult);
      } catch (speakError) {
        debugLog("sendChatPrompt:speak:error", speakError?.message || String(speakError));
      }
    }
  } catch (error) {
    debugLog("sendChatPrompt:error", error?.message || String(error));
    showBubble("刚刚没接好", 1500);
  } finally {
    chatRequestInFlight = false;
    if (chatSend) chatSend.disabled = false;
    if (chatInput) chatInput.disabled = false;
  }
}

let isDragging = false;
let didDrag = false; // true if pointer moved > threshold during this press
let lastScreenX, lastScreenY;
let mouseDownX, mouseDownY;
let pendingDx = 0, pendingDy = 0;
let dragRAF = null;
const DRAG_THRESHOLD = 3; // px — less than this = click, more = drag

container.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (e.target && (e.target.closest("#chat-toggle") || e.target.closest("#chat-panel"))) {
      debugLog("container:pointerdown:skip-drag-for-chat-ui");
      return;
    }
    if (miniMode) { didDrag = false; return; }
    container.setPointerCapture(e.pointerId);  // Guarantees pointerup even if pointer leaves window
    isDragging = true;
    didDrag = false;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    pendingDx = 0;
    pendingDy = 0;
    window.electronAPI.dragLock(true);
    container.classList.add("dragging");
  }
});

document.addEventListener("pointermove", (e) => {
  if (isDragging) {
    pendingDx += e.screenX - lastScreenX;
    pendingDy += e.screenY - lastScreenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;

    // Mark as drag if moved beyond threshold
    if (!didDrag) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
        didDrag = true;
        startDragReaction();
      }
    }

    if (!dragRAF) {
      dragRAF = requestAnimationFrame(() => {
        window.electronAPI.moveWindowBy(pendingDx, pendingDy);
        pendingDx = 0;
        pendingDy = 0;
        dragRAF = null;
      });
    }
  }
});

function stopDrag() {
  if (!isDragging) return;
  isDragging = false;
  window.electronAPI.dragLock(false);
  container.classList.remove("dragging");
  // Flush pending delta before releasing
  if (pendingDx !== 0 || pendingDy !== 0) {
    if (dragRAF) { cancelAnimationFrame(dragRAF); dragRAF = null; }
    window.electronAPI.moveWindowBy(pendingDx, pendingDy);
    pendingDx = 0; pendingDy = 0;
  }
  // Only trigger edge snap check on actual drags (not clicks)
  if (didDrag) {
    window.electronAPI.dragEnd();
  }
  endDragReaction();
}

document.addEventListener("pointerup", (e) => {
  if (e.button === 0) {
    const wasDrag = didDrag;
    stopDrag();
    if (!wasDrag) {
      handleClick(e.clientX);
    }
  }
});

// Pointer Capture can end via OS interruption (Alt+Tab, system dialog, etc.)
container.addEventListener("pointercancel", stopDrag);
container.addEventListener("lostpointercapture", () => {
  if (isDragging) stopDrag();
});

window.addEventListener("blur", stopDrag);

// --- Do Not Disturb (synced from main process) ---
let dndEnabled = false;
window.electronAPI.onDndChange((enabled) => { dndEnabled = enabled; });

// --- Mini Mode (synced from main process) ---
let miniMode = false;
window.electronAPI.onMiniModeChange((enabled) => {
  miniMode = enabled;
  container.style.cursor = enabled ? "default" : "";
});

// --- Click reaction (2-click = poke, 4-click = flail) ---
const CLICK_WINDOW_MS = 400;  // max gap between consecutive clicks
const REACT_LEFT_SVG = "clawd-react-left.svg";
const REACT_RIGHT_SVG = "clawd-react-right.svg";
const REACT_DOUBLE_SVG = "clawd-react-double.svg";
const REACT_DRAG_SVG = "clawd-react-drag.svg";
const REACT_SINGLE_DURATION = 2500;
const REACT_DOUBLE_DURATION = 3500;

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;     // direction from the first click in a sequence
let isReacting = false;       // click reaction animation is playing
let isDragReacting = false;   // drag reaction is active
let reactTimer = null;        // auto-return timer
let currentIdleSvg = null;    // tracks which SVG is currently showing

function handleClick(clientX) {
  if (miniMode) {
    window.electronAPI.exitMiniMode();
    return;
  }
  if (isReacting || isDragReacting) return;
  if (currentIdleSvg !== "clawd-idle-follow.svg") return;

  clickCount++;
  if (clickCount === 1) {
    firstClickDir = clientX < container.offsetWidth / 2 ? "left" : "right";
  }

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  if (clickCount >= 4) {
    // 4+ clicks → flail reaction (东张西望)
    clickCount = 0;
    firstClickDir = null;
    playReaction(REACT_DOUBLE_SVG, REACT_DOUBLE_DURATION);
  } else if (clickCount >= 2) {
    // 2-3 clicks → wait briefly for more, then poke reaction
    clickTimer = setTimeout(() => {
      clickTimer = null;
      const svg = firstClickDir === "left" ? REACT_LEFT_SVG : REACT_RIGHT_SVG;
      clickCount = 0;
      firstClickDir = null;
      playReaction(svg, REACT_SINGLE_DURATION);
    }, CLICK_WINDOW_MS);
  } else {
    // 1 click → wait for more (single click alone does nothing)
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      firstClickDir = null;
    }, CLICK_WINDOW_MS);
  }
}

function playReaction(svgFile, durationMs) {
  isReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();

  // Reuse existing swap pattern
  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }

  const next = document.createElement("object");
  next.data = `../assets/svg/${svgFile}`;
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";
  container.appendChild(next);
  pendingNext = next;

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;
  };

  next.addEventListener("load", swap, { once: true });
  setTimeout(() => {
    if (pendingNext !== next) return;
    // If SVG failed to load, abandon swap and keep current display
    try { if (!next.contentDocument) { next.remove(); pendingNext = null; return; } } catch {}
    swap();
  }, 3000);

  reactTimer = setTimeout(() => endReaction(), durationMs);
}

function endReaction() {
  if (!isReacting) return;
  isReacting = false;
  reactTimer = null;
  window.electronAPI.resumeFromReaction();
}

function cancelReaction() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickCount = 0; firstClickDir = null; }
  if (isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
  }
  if (isDragReacting) {
    isDragReacting = false;
  }
}

// --- Drag reaction (loops while dragging, idle-follow only) ---
function swapToSvg(svgFile) {
  if (pendingNext) { pendingNext.remove(); pendingNext = null; }
  const next = document.createElement("object");
  next.data = `../assets/svg/${svgFile}`;
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";
  container.appendChild(next);
  pendingNext = next;
  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;
  };
  next.addEventListener("load", swap, { once: true });
  setTimeout(() => {
    if (pendingNext !== next) return;
    try { if (!next.contentDocument) { next.remove(); pendingNext = null; return; } } catch {}
    swap();
  }, 3000);
}

function startDragReaction() {
  if (isDragReacting) return;
  if (dndEnabled) return;  // DND: just move the window, no reaction animation

  // Drag interrupts click reaction if active
  if (isReacting) {
    if (reactTimer) { clearTimeout(reactTimer); reactTimer = null; }
    isReacting = false;
  }

  isDragReacting = true;
  detachEyeTracking();
  window.electronAPI.pauseCursorPolling();
  swapToSvg(REACT_DRAG_SVG);
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  window.electronAPI.resumeFromReaction();
}

// --- State change → switch SVG animation (preload + instant swap) ---
let clawdEl = document.getElementById("clawd");
let pendingNext = null;

window.electronAPI.onStateChange((state, svg) => {
  // Main process state change → cancel any active click reaction
  cancelReaction();

  if (pendingNext) {
    pendingNext.remove();
    pendingNext = null;
  }
  detachEyeTracking();

  const next = document.createElement("object");
  next.data = `../assets/svg/${svg}`;
  next.type = "image/svg+xml";
  next.id = "clawd";
  next.style.opacity = "0";
  container.appendChild(next);
  pendingNext = next;

  const swap = () => {
    if (pendingNext !== next) return;
    next.style.transition = "none";
    next.style.opacity = "1";
    for (const child of [...container.querySelectorAll("object")]) {
      if (child !== next) child.remove();
    }
    pendingNext = null;
    clawdEl = next;

    if (svg === "clawd-idle-follow.svg" || svg.startsWith("clawd-mini-")) {
      attachEyeTracking(next);
    } else {
      detachEyeTracking();
    }

    // Track current SVG for click reaction gating
    currentIdleSvg = svg;
  };

  next.addEventListener("load", swap, { once: true });
  setTimeout(() => {
    if (pendingNext !== next) return;
    try { if (!next.contentDocument) { next.remove(); pendingNext = null; return; } } catch {}
    swap();
  }, 3000);
});

// --- Eye tracking (idle state only) ---
let eyeTarget = null;
let bodyTarget = null;
let shadowTarget = null;

function attachEyeTracking(objectEl) {
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;
  try {
    const svgDoc = objectEl.contentDocument;
    if (svgDoc) {
      eyeTarget = svgDoc.getElementById("eyes-js");
      bodyTarget = svgDoc.getElementById("body-js");
      shadowTarget = svgDoc.getElementById("shadow-js");
    }
  } catch (e) {
    console.warn("Cannot access SVG contentDocument for eye tracking:", e.message);
  }
}

function detachEyeTracking() {
  eyeTarget = null;
  bodyTarget = null;
  shadowTarget = null;
}

window.electronAPI.onEyeMove((dx, dy) => {
  if (eyeTarget) {
    eyeTarget.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  if (bodyTarget || shadowTarget) {
    const bdx = Math.round(dx * 0.33 * 2) / 2;
    const bdy = Math.round(dy * 0.33 * 2) / 2;
    if (bodyTarget) bodyTarget.style.transform = `translate(${bdx}px, ${bdy}px)`;
    if (shadowTarget) {
      // Shadow stretches toward lean direction (feet stay anchored)
      const absDx = Math.abs(bdx);
      const scaleX = 1 + absDx * 0.15;
      const shiftX = Math.round(bdx * 0.3 * 2) / 2;
      shadowTarget.style.transform = `translate(${shiftX}px, 0) scaleX(${scaleX})`;
    }
  }
});

// --- Wake from doze (smooth eye opening) ---
window.electronAPI.onWakeFromDoze(() => {
  if (clawdEl && clawdEl.contentDocument) {
    try {
      const eyes = clawdEl.contentDocument.getElementById("eyes-doze");
      if (eyes) eyes.style.transform = "scaleY(1)";
    } catch (e) {}
  }
});

// --- Right-click context menu ---
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.electronAPI.showContextMenu();
});


chatToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  if (window.electronAPI?.openControls) {
    window.electronAPI.openControls();
    return;
  }
  setPanelOpen(!panelOpen);
});

chatSend.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
});
chatVoice?.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
chatCode?.addEventListener("pointerdown", (e) => { e.stopPropagation(); });

chatSend.addEventListener("click", (e) => {
  e.stopPropagation();
  debugLog("chatSend:click");
  sendChatPrompt();
});
chatVoice?.addEventListener("click", async (e) => {
  e.stopPropagation();
  debugLog("chatVoice:click", { recording });
  await toggleVoiceRecording();
});
chatCode?.addEventListener("click", async (e) => {
  e.stopPropagation();
  debugLog("chatCode:click");
  await runCodingPrompt();
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    if (/^\/code\s+/i.test(String(chatInput.value || "").trim())) {
      runCodingPrompt();
    } else {
      sendChatPrompt();
    }
  }
  if (e.key === "Escape") setPanelOpen(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !panelOpen) {
    e.preventDefault();
    debugLog("keyboard:open-panel");
    setPanelOpen(true);
  }
});

syncBridgeStatus();
