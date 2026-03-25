#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

async function main() {
  const text = String(process.argv.slice(2).join(' ') || '').trim();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(JSON.stringify({ ok: false, error: 'missing_openai_api_key' }));
    process.exit(1);
  }
  if (!text) {
    console.error(JSON.stringify({ ok: false, error: 'empty_text' }));
    process.exit(1);
  }

  const body = {
    model: 'gpt-4o-mini-tts',
    voice: 'cedar',
    input: text,
    format: 'wav',
    instructions: [
      'Render in premium cinematic intimate English.',
      'Target timbre: warm baritone-leaning male, slightly husky, velvet texture, low-mid resonance, soft chest presence, restrained top-end brightness.',
      'Prosody target: natural conversational micro-pauses, legato phrase connection, low attack transients, softened consonant edges, no clipped cadence, no broadcast contour.',
      'Dynamic profile: close-mic intimacy, low-amplitude emotional control, subtle breath audibility, emotionally intelligent restraint, never theatrical, never commercially upbeat.',
      'Spatial impression: dry close vocal, private ear-level presence, no stage projection, no public-speaking energy, no presenter smile.',
      'Performance note: speak as if to one specific person at very close range, with calm desire to comfort, attract, and hold attention gently rather than perform outwardly.',
      'Tonal brief: magnetic, mature, elegant, slightly smoky, soft-grained, fluid, immersive, affectionate but controlled.',
      'Avoid all assistant-like, service-like, explainer-like, audiobook-like, or announcer-like rhythm.',
      'Sentence endings should land softly, with breath-led tapering rather than crisp stop consonants.',
      'Overall result should feel cinematic, sensual in a restrained way, intimate, expensive, and emotionally alive.'
    ].join(' ')
  };

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(JSON.stringify({ ok: false, error: 'openai_tts_failed', status: res.status, detail: errText }));
    process.exit(1);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const outPath = path.join(os.tmpdir(), `clawd-tts-${Date.now()}.wav`);
  fs.writeFileSync(outPath, buf);
  process.stdout.write(JSON.stringify({ ok: true, path: outPath, voice: body.voice }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || 'unknown_error' }));
  process.exit(1);
});
