#!/usr/bin/env node
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

async function main() {
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.error(JSON.stringify({ ok: false, error: 'missing_input_audio' }));
    process.exit(1);
  }

  const outPath = path.join(os.tmpdir(), `clawd-transcript-${Date.now()}.txt`);
  const script = '/opt/homebrew/lib/node_modules/openclaw/skills/openai-whisper-api/scripts/transcribe.sh';

  execFile('bash', [script, input, '--out', outPath], {
    cwd: __dirname,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
    env: process.env,
  }, (error, stdout, stderr) => {
    if (error) {
      console.error(JSON.stringify({ ok: false, error: stderr || error.message }));
      process.exit(1);
      return;
    }
    try {
      const text = fs.readFileSync(outPath, 'utf8').trim();
      process.stdout.write(JSON.stringify({ ok: true, text, outPath, stdout, stderr }));
    } catch (readError) {
      console.error(JSON.stringify({ ok: false, error: readError.message || 'read_transcript_failed' }));
      process.exit(1);
    }
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || 'unknown_error' }));
  process.exit(1);
});
