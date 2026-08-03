const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { exec } = require('child_process');
const { promisify } = require('util');
const { Logger } = require('./logger');

const execAsync = promisify(exec);

// Microsoft Edge's online TTS — free, no API key, no daily quota. Used for
// long-form narration so the scarce Gemini TTS free tier (15 requests/day)
// isn't the bottleneck on 3000+ word scripts. Shipped as a CLI inside
// MoneyPrinterTurbo's venv, which already lives beside this project.
const EDGE_TTS_BIN = path.resolve(
  __dirname, '..', '..', '..', 'MoneyPrinterTurbo', '.venv', 'bin', 'edge-tts'
);

// GuyNeural: measured, documentary-appropriate US male voice — matches the
// calm true-crime/history tone. Swap here to change the long-form voice.
const DEFAULT_VOICE = 'en-US-GuyNeural';

class EdgeTTS {
  constructor(voice = DEFAULT_VOICE) {
    this.voice = voice;
    this.logger = new Logger('EdgeTTS');
  }

  // Split on sentence boundaries into ≤maxChars chunks — a single edge-tts
  // call on a very long script occasionally drops audio or times out; chunking
  // keeps each request small and lets us concatenate seamlessly.
  splitIntoChunks(text, maxChars = 2500) {
    const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [text];
    const chunks = [];
    let cur = '';
    for (const s of sentences) {
      if (cur.length && (cur.length + s.length) > maxChars) {
        chunks.push(cur.trim());
        cur = '';
      }
      cur += s;
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks;
  }

  runEdgeTTS(text, outMedia) {
    return new Promise((resolve, reject) => {
      const proc = spawn(EDGE_TTS_BIN, [
        '--voice', this.voice,
        '--text', text,
        '--write-media', outMedia
      ], { env: { ...process.env } });
      let stderr = '';
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('edge-tts timed out'));
      }, 120000);
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => { clearTimeout(killTimer); reject(err); });
      proc.on('close', code => {
        clearTimeout(killTimer);
        if (code === 0) resolve();
        else reject(new Error(`edge-tts exited ${code}: ${stderr.slice(-300)}`));
      });
    });
  }

  // Generate narration MP3 from text. Signature mirrors GeminiTTS.generate so
  // callers can swap providers without other changes. Returns the mp3 path.
  async generate(text, outputPath) {
    this.logger.info(`Generating narration with edge-tts (${this.voice})...`);
    const mp3Path = outputPath.replace(/\.[^.]+$/, '.mp3');
    const chunks = this.splitIntoChunks(text);

    if (chunks.length === 1) {
      await this.runEdgeTTS(chunks[0], mp3Path);
      const stats = await fs.stat(mp3Path);
      this.logger.info(`Narration saved: ${mp3Path} (${(stats.size / 1024).toFixed(0)} KB)`);
      return mp3Path;
    }

    // Multiple chunks — render each, then concat with ffmpeg (re-encode so
    // any codec/bitrate drift between chunks doesn't corrupt the join).
    this.logger.info(`Narration is ${text.length} chars — ${chunks.length} edge-tts calls`);
    const tmpDir = path.join(os.tmpdir(), `edgetts_${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const partPaths = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const part = path.join(tmpDir, `part_${String(i).padStart(3, '0')}.mp3`);
        await this.runEdgeTTS(chunks[i], part);
        partPaths.push(part);
        this.logger.info(`  chunk ${i + 1}/${chunks.length} done`);
      }
      const listFile = path.join(tmpDir, 'concat.txt');
      await fs.writeFile(listFile, partPaths.map(p => `file '${p}'`).join('\n'));
      await execAsync(
        `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -b:a 192k -ar 44100 "${mp3Path}"`,
        { timeout: 120000 }
      );
      const stats = await fs.stat(mp3Path);
      this.logger.info(`Narration saved: ${mp3Path} (${(stats.size / 1024).toFixed(0)} KB, ${chunks.length} chunks)`);
      return mp3Path;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { EdgeTTS };
