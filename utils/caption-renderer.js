const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { Logger } = require('./logger');

const execAsync = promisify(exec);

// Video canvas — Shorts (portrait) is the default; pass format:'long' for landscape.
const DIMENSIONS = {
  short: { width: 1080, height: 1920 },
  long:  { width: 1920, height: 1080 }
};

// Caption style — bold yellow fill, thick black outline (matches the reference).
const FONT_SIZE = 92;
const STROKE_W  = 14;
const FILL      = '#FFE800';
const STROKE    = '#000000';
const MAX_CHARS = 18;   // per caption chunk — ~2-3 short words on one line
const MAX_WORDS = 3;

const MODEL_PATH = path.join(__dirname, '..', 'models', 'ggml-base.en.bin');

class CaptionRenderer {
  constructor(format = 'short') {
    this.logger = new Logger('Captions');
    const dims = DIMENSIONS[format] || DIMENSIONS.short;
    this.WIDTH  = dims.width;
    this.HEIGHT = dims.height;
    // Caption baseline — lower third of the screen. Text is centred on this Y.
    this.CAP_CENTER_Y = Math.round(this.HEIGHT * 0.80);
  }

  // Transcribe audio → word-level timestamps via whisper.cpp. Returns [{text,start,end}] (sec).
  async transcribe(audioPath) {
    const stamp = Date.now();
    const wav = path.join(os.tmpdir(), `cap_${stamp}.wav`);
    const outBase = path.join(os.tmpdir(), `cap_${stamp}_words`);

    await execAsync(`ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 "${wav}" -loglevel error`);
    await execAsync(
      `whisper-cli -m "${MODEL_PATH}" -f "${wav}" -ml 1 -oj -of "${outBase}" --no-prints`,
      { timeout: 120000 }
    );

    const data = JSON.parse(await fs.readFile(`${outBase}.json`, 'utf8'));
    await fs.unlink(wav).catch(() => {});
    await fs.unlink(`${outBase}.json`).catch(() => {});

    const words = [];
    for (const tok of data.transcription || []) {
      const raw = tok.text || '';
      const text = raw.trim();
      if (!text) continue;
      // No leading space → continuation of previous word (whisper splits long words).
      // Bare punctuation also attaches to the previous word.
      const isContinuation = words.length && (!/^\s/.test(raw) || /^[.,!?;:'"]+$/.test(text));
      if (isContinuation) {
        words[words.length - 1].text += text;
        words[words.length - 1].end = tok.offsets.to / 1000;
        continue;
      }
      words.push({ text, start: tok.offsets.from / 1000, end: tok.offsets.to / 1000 });
    }
    return words;
  }

  // Group words into short caption chunks (2-3 words), breaking on sentence ends.
  groupIntoChunks(words) {
    const chunks = [];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      chunks.push({
        text:  cur.map(w => w.text).join(' '),
        start: cur[0].start,
        end:   cur[cur.length - 1].end
      });
      cur = [];
    };
    for (const w of words) {
      const projected = cur.map(x => x.text).join(' ') + ' ' + w.text;
      if (cur.length && (cur.length >= MAX_WORDS || projected.length > MAX_CHARS)) flush();
      cur.push(w);
      if (/[.!?]$/.test(w.text)) flush();
    }
    flush();
    return chunks;
  }

  // Render one caption as a FULL-FRAME (1080x1920) transparent PNG with the
  // text centred on CAP_CENTER_Y. Long chunks wrap to a second line.
  async renderFrame(text, outPath) {
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                     .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const svg = `<svg width="${this.WIDTH}" height="${this.HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity="0.55"/>
        </filter>
      </defs>
      <text x="${this.WIDTH / 2}" y="${this.CAP_CENTER_Y}"
        font-family="Montserrat" font-weight="900" font-size="${FONT_SIZE}"
        fill="${FILL}" stroke="${STROKE}" stroke-width="${STROKE_W}"
        paint-order="stroke" stroke-linejoin="round"
        text-anchor="middle" dominant-baseline="middle"
        filter="url(#sh)" letter-spacing="1">${safe}</text>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(outPath);
  }

  // Build a transparent caption-track video (qtrle .mov, lossless alpha) the
  // assembler can overlay in one pass. Uses the concat demuxer with timed PNGs
  // and a shared transparent spacer for the gaps between captions.
  async buildTrack(chunks, totalDuration, workDir, idPrefix) {
    const spacer = path.join(workDir, `${idPrefix}_spacer.png`);
    await sharp({ create: { width: this.WIDTH, height: this.HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toFile(spacer);

    // Render each caption frame
    for (let i = 0; i < chunks.length; i++) {
      const png = path.join(workDir, `${idPrefix}_cap_${i}.png`);
      await this.renderFrame(chunks[i].text, png);
      chunks[i].png = png;
    }

    // Build concat list: spacer for gaps, caption frame for its window
    const lines = [];
    let cursor = 0;
    const addEntry = (file, dur) => {
      if (dur <= 0) return;
      lines.push(`file '${file.replace(/'/g, "'\\''")}'`);
      lines.push(`duration ${dur.toFixed(3)}`);
    };
    for (const c of chunks) {
      if (c.start > cursor) addEntry(spacer, c.start - cursor);
      const end = Math.min(c.end, totalDuration);
      addEntry(c.png, Math.max(0.05, end - c.start));
      cursor = end;
    }
    if (cursor < totalDuration) addEntry(spacer, totalDuration - cursor);
    // concat demuxer ignores the final entry's duration unless the file is repeated
    if (lines.length) lines.push(`file '${spacer.replace(/'/g, "'\\''")}'`);

    const listPath = path.join(workDir, `${idPrefix}_concat.txt`);
    await fs.writeFile(listPath, lines.join('\n'));

    const trackPath = path.join(workDir, `${idPrefix}_captions.mov`);
    await execAsync(
      `ffmpeg -y -f concat -safe 0 -i "${listPath}" ` +
      `-vf "fps=30,format=rgba" -c:v qtrle -t ${totalDuration} "${trackPath}" -loglevel error`,
      { timeout: 180000, maxBuffer: 1024 * 1024 * 32 }
    );

    return trackPath;
  }

  // Full pipeline: audio → transparent caption-track .mov.
  // Returns { trackPath, chunkCount } or null on failure.
  async generate(audioPath, workDir, idPrefix, totalDuration) {
    try {
      const words = await this.transcribe(audioPath);
      if (!words.length) {
        this.logger.warn('No words transcribed — skipping captions');
        return null;
      }
      const chunks = this.groupIntoChunks(words);
      this.logger.info(`Transcribed ${words.length} words → ${chunks.length} caption chunks`);

      await fs.mkdir(workDir, { recursive: true });
      const trackPath = await this.buildTrack(chunks, totalDuration, workDir, idPrefix);
      this.logger.info(`Caption track built: ${path.basename(trackPath)}`);
      return { trackPath, chunkCount: chunks.length };
    } catch (err) {
      this.logger.error('Caption generation failed:', err.message);
      return null;
    }
  }
}

module.exports = { CaptionRenderer };
