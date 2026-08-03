// Standalone comparison test — Option B: per-item Pexels stock visuals,
// segment-cut long-form assembly. Same script/topic as the OpenMontage
// doodle test, so the only variable being compared is visual style.
const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { GeminiTTS } = require('../../utils/gemini-tts');
const { VideoAssembler } = require('../../utils/video-assembler');

const ROOT = __dirname;
const CREDS = require('../../config/credentials.json');
const W = 1920, H = 1080;

const CLIP_QUERIES = [
  'vintage science laboratory experiment',
  'confidential documents paperwork stack',
  'paper shredder office documents',
  'cardboard box warehouse storage',
  'government congress hearing courtroom'
];

// (start, end) in seconds — filled in after we know the real narration length
function buildCaptions(narrationDur) {
  const leadIn = 2.5, outro = 4.0;
  const total = leadIn + narrationDur + outro;
  const scale = (total - leadIn - outro) / 37.69; // tuned against a 37.69s reference narration
  const s = (t) => +(t * scale).toFixed(2);
  return {
    total,
    segments: [
      { start: 0,          end: leadIn + s(7.1)  },
      { start: leadIn+s(7.1), end: leadIn + s(13.4) },
      { start: leadIn+s(13.4), end: leadIn + s(22.1) },
      { start: leadIn+s(22.1), end: leadIn + s(29.2) },
      { start: leadIn+s(29.2), end: total }
    ],
    cards: [
      { text: '1953 · Project MKUltra',                                  start: 2.0,          end: leadIn + s(6.5) },
      { text: 'Unwitting subjects. No consent.',                         start: leadIn+s(8.3),  end: leadIn + s(12.2) },
      { text: '1973 — fearing exposure, the records are destroyed.',     start: leadIn+s(16.6), end: leadIn + s(21.7) },
      { text: '1977 — found by accident, in a budget warehouse.',        start: leadIn+s(24.3), end: leadIn + s(28.8) },
      { text: 'Congress held hearings. Survivors came forward.',         start: leadIn+s(29.6), end: leadIn + s(34.7) },
      { text: 'To this day, nobody knows how many people were used.',    start: leadIn+s(35.1), end: leadIn + s(narrationDur) },
      { text: 'The mind-control program America forgot', sub: 'declassified history · Church Committee, 1975', start: total - 3.3, end: total }
    ]
  };
}

async function makeCard(text, sub, outputPath) {
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="shadow"><feDropShadow dx="0" dy="3" stdDeviation="8" flood-color="#000000" flood-opacity="0.85"/></filter>
    </defs>
    <rect x="0" y="${H - 220}" width="${W}" height="220" fill="black" opacity="0.45"/>
    <text x="${W / 2}" y="${H - 120}" font-family="Arial" font-size="56" font-weight="900"
      fill="white" text-anchor="middle" filter="url(#shadow)">${escapeXml(text)}</text>
    ${sub ? `<text x="${W / 2}" y="${H - 60}" font-family="Arial" font-size="32" fill="#cfcfcf" text-anchor="middle">${escapeXml(sub)}</text>` : ''}
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
  const assembler = new VideoAssembler(CREDS.pexels.apiKey, CREDS.pixabay.apiKey, 'long');

  const scriptText = (await fs.readFile(path.join(ROOT, 'script.txt'), 'utf8')).trim();
  let narrationPath = path.join(ROOT, 'narration.mp3');
  const exists = await fs.access(narrationPath).then(() => true).catch(() => false);
  if (!exists) {
    const tts = new GeminiTTS(CREDS.gemini.apiKey);
    console.log('Generating narration...');
    narrationPath = await tts.generate(scriptText, narrationPath);
  } else {
    console.log('Reusing existing narration.mp3');
  }

  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${narrationPath}"`
  );
  const narrationDuration = parseFloat(stdout.trim());
  console.log(`Narration duration: ${narrationDuration.toFixed(2)}s`);

  const plan = buildCaptions(narrationDuration);

  // Fetch one Pexels clip per story beat (skip re-fetch if already present).
  const clipPaths = [];
  for (let i = 0; i < CLIP_QUERIES.length; i++) {
    const clipPath = path.join(ROOT, `clip${i}.mp4`);
    const has = await fs.access(clipPath).then(() => true).catch(() => false);
    if (!has) {
      console.log(`Fetching clip ${i + 1}/${CLIP_QUERIES.length} — query: "${CLIP_QUERIES[i]}"`);
      const ok = await assembler.fetchPexelsVideoByQuery(CLIP_QUERIES[i], clipPath);
      if (!ok) throw new Error(`Failed to fetch clip for query: ${CLIP_QUERIES[i]}`);
    }
    clipPaths.push(clipPath);
  }

  // Render caption card PNGs.
  const cardPaths = [];
  for (let i = 0; i < plan.cards.length; i++) {
    const c = plan.cards[i];
    const p = path.join(ROOT, `card${i}.png`);
    await makeCard(c.text, c.sub, p);
    cardPaths.push(p);
  }

  const inputs = [];
  clipPaths.forEach((p, i) => {
    const segDur = (plan.segments[i].end - plan.segments[i].start).toFixed(3);
    inputs.push(`-stream_loop -1 -t ${segDur} -i "${p}"`);
  });
  const clipCount = clipPaths.length;
  inputs.push(`-i "${narrationPath}"`);
  const audioIdx = clipCount;
  cardPaths.forEach((p) => inputs.push(`-loop 1 -i "${p}"`));

  const scaleParts = clipPaths.map((_, i) =>
    `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,lutyuv=y=val*0.55:u=val:v=val[v${i}]`
  ).join(';');
  const concatIn = clipPaths.map((_, i) => `[v${i}]`).join('');

  let overlayChain = `${concatIn}concat=n=${clipCount}:v=1:a=0[base]`;
  let vlabel = '[base]';
  plan.cards.forEach((c, i) => {
    const cardInputIdx = audioIdx + 1 + i;
    const outLabel = `[c${i}]`;
    overlayChain += `;${vlabel}[${cardInputIdx}:v]overlay=0:0:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'${outLabel}`;
    vlabel = outLabel;
  });

  const filterComplex = `${scaleParts};${overlayChain}`;
  const outputPath = path.join(ROOT, 'renders', 'mkultra-stockvisual.mp4');
  await fs.mkdir(path.join(ROOT, 'renders'), { recursive: true });

  const cmd = [
    'ffmpeg -y',
    inputs.join(' '),
    '-filter_complex', `"${filterComplex}"`,
    '-filter:a', `"adelay=2500|2500"`,
    `-map "${vlabel}" -map "${audioIdx}:a"`,
    '-c:v libx264 -preset veryfast -crf 20',
    '-c:a aac -b:a 192k -ar 44100',
    '-pix_fmt yuv420p',
    `-t ${plan.total.toFixed(2)}`,
    '-movflags +faststart',
    `"${outputPath}"`
  ].join(' ');

  console.log('Assembling final video...');
  await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
  console.log(`Done: ${outputPath} (${plan.total.toFixed(1)}s)`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
