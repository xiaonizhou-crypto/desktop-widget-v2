#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const action = process.argv[2] || 'toggle';
const pidPath = '/tmp/clawd-ambient.pid';
const audioPath = path.join(__dirname, 'assets', 'ambient-rain.mp3');

function readPid() {
  try { return Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch { return null; }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stop() {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  try { fs.unlinkSync(pidPath); } catch {}
  process.stdout.write(JSON.stringify({ ok: true, action: 'stop', playing: false }));
}

function start() {
  if (!fs.existsSync(audioPath)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing_audio', path: audioPath }));
    process.exit(1);
    return;
  }
  const child = spawn('afplay', ['-v', '0.18', audioPath], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid), 'utf8');
  process.stdout.write(JSON.stringify({ ok: true, action: 'start', playing: true, pid: child.pid, path: audioPath }));
}

if (action === 'stop') {
  stop();
} else if (action === 'start') {
  start();
} else {
  const pid = readPid();
  if (pid && isRunning(pid)) stop();
  else start();
}
