#!/usr/bin/env node
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const V2_ROOT = __dirname;
const REF_AUDIO = path.join(V2_ROOT, 'voice-reference.wav');
const SCRIPT = '/Users/tricia/.openclaw/workspace/.agents/skills/tts/scripts/tts.py';
const FALLBACK_VOICE_ID = '95814add';
const MIN_SECONDS = 0.6;
const FALLBACK_MIN_TEXT = 'Hello... come a little closer. I am right here with you.';

function softenText(text) {
  return text
    .replace(/I am/g, "I'm")
    .replace(/do not/g, "don't")
    .replace(/cannot/g, "can't")
    .replace(/Hello/gi, 'hello')
    .replace(/Hi/g, 'hi')
    .replace(/!/g, '.')
    .replace(/\?+/g, '?')
    .replace(/\.{2,}/g, '.')
    .replace(/, /g, ',  ')
    .replace(/\. /g, '.   ')
    .replace(/; /g, ';  ')
    .replace(/ and /g, ' and  ')
    .replace(/，/g, '， ')
    .replace(/。/g, '。  ')
    .replace(/；/g, '； ')
    .replace(/、/g, '、');
}

function getWavDurationSeconds(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 44) return 0;
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
    const dataSize = buf.readUInt32LE(40);
    const bytesPerSample = channels * (bitsPerSample / 8);
    if (!sampleRate || !bytesPerSample) return 0;
    return dataSize / (sampleRate * bytesPerSample);
  } catch {
    return 0;
  }
}

async function synthesize(args, outPath) {
  await execFileAsync('python3', args, {
    cwd: '/Users/tricia/.openclaw/workspace',
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
    env: {
      ...process.env,
      CLAWD_TTS_STYLE: 'low-posture soft doubled duvet-lover intimate whisper-near'
    },
  });
  const seconds = getWavDurationSeconds(outPath);
  return { seconds, outPath };
}

async function main() {
  const text = String(process.argv.slice(2).join(' ') || '').trim();
  if (!text) {
    console.error(JSON.stringify({ ok: false, error: 'empty_text' }));
    process.exit(1);
  }

  const softened = softenText(text);
  const expandedFallbackText = softenText(text.length < 18 ? `${text} ... ${FALLBACK_MIN_TEXT}` : text);
  const textExpandedForFallback = expandedFallbackText !== softened;
  const outPath = path.join(os.tmpdir(), `clawd-noiz-${Date.now()}.wav`);
  const refArgs = [SCRIPT, '-t', softened, '--speed', '0.82', '-o', outPath, '--ref-audio', REF_AUDIO, '--similarity-enh'];
  const fallbackArgs = [SCRIPT, '-t', expandedFallbackText, '--voice-id', FALLBACK_VOICE_ID, '--speed', '0.84', '-o', outPath];

  try {
    if (fs.existsSync(REF_AUDIO)) {
      const refResult = await synthesize(refArgs, outPath);
      if (refResult.seconds >= MIN_SECONDS) {
        process.stdout.write(JSON.stringify({ ok: true, path: outPath, provider: 'noiz', refAudio: REF_AUDIO, seconds: refResult.seconds, mode: 'reference', textExpandedForFallback: false }));
        return;
      }
      const fallbackResult = await synthesize(fallbackArgs, outPath);
      process.stdout.write(JSON.stringify({ ok: true, path: outPath, provider: 'noiz', refAudio: REF_AUDIO, seconds: fallbackResult.seconds, mode: 'fallback-voice-id', fallbackVoiceId: FALLBACK_VOICE_ID, fallbackReason: `reference_too_short_${refResult.seconds.toFixed(3)}s`, textExpandedForFallback }));
      return;
    }

    const fallbackResult = await synthesize(fallbackArgs, outPath);
    process.stdout.write(JSON.stringify({ ok: true, path: outPath, provider: 'noiz', refAudio: null, seconds: fallbackResult.seconds, mode: 'voice-id-only', fallbackVoiceId: FALLBACK_VOICE_ID, textExpandedForFallback }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message || 'unknown_error', refAudio: fs.existsSync(REF_AUDIO) ? REF_AUDIO : null }));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || 'unknown_error' }));
  process.exit(1);
});
