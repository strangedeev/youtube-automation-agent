const axios = require('axios');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const path = require('path');
const { Logger } = require('./logger');

const execAsync = promisify(exec);

const VOICE_NAME = 'Aoede'; // Breezy, conversational — natural fit for Reddit story narration
const MODEL = 'gemini-2.5-flash-preview-tts';
const MAX_CHARS = 4800;
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

class GeminiTTS {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.logger = new Logger('GeminiTTS');
  }

  // Build a proper WAV header for raw PCM data
  buildWavHeader(dataLength) {
    const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
    const blockAlign = CHANNELS * (BIT_DEPTH / 8);
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);           // PCM chunk size
    header.writeUInt16LE(1, 20);            // PCM format
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BIT_DEPTH, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);

    return header;
  }

  // Split text into ≤maxChars chunks on sentence boundaries — never mid-word,
  // never mid-sentence. Long-form narration reliably exceeds a single Gemini
  // TTS call's output ceiling, so it must be synthesized in multiple calls.
  splitIntoChunks(text, maxChars) {
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

  // One Gemini TTS call → raw PCM buffer for that chunk of text.
  async generateChunkAudio(text) {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${this.apiKey}`,
      {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } }
          }
        }
      },
      { timeout: 180000 }
    );

    const part = response.data?.candidates?.[0]?.content?.parts?.[0];
    if (!part?.inlineData?.data) {
      throw new Error('No audio data in Gemini TTS response');
    }
    return Buffer.from(part.inlineData.data, 'base64');
  }

  async generate(text, outputPath) {
    this.logger.info('Generating TTS audio with Gemini 2.5 Flash TTS...');

    // A single Gemini TTS call silently truncates output past a length
    // ceiling instead of erroring — invisible on short Shorts narration
    // (always well under MAX_CHARS) but it was cutting long-form scripts
    // roughly in half. Chunk on sentence boundaries and concatenate the
    // raw PCM (same sample rate/format across chunks, so this is gapless).
    const chunks = this.splitIntoChunks(text, MAX_CHARS);
    if (chunks.length > 1) {
      this.logger.info(`Narration is ${text.length} chars — splitting into ${chunks.length} TTS calls`);
    }

    // Gemini TTS free tier allows 3 requests/minute — back-to-back chunk
    // calls on long-form scripts breach it and burn the 15/day quota on
    // retries. 21s spacing keeps any 60s window at ≤3 requests.
    const CHUNK_SPACING_MS = 21000;
    const pcmBuffers = [];
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length > 1) this.logger.info(`TTS chunk ${i + 1}/${chunks.length}...`);
      if (i > 0) await new Promise(r => setTimeout(r, CHUNK_SPACING_MS));
      pcmBuffers.push(await this.generateChunkAudio(chunks[i]));
    }
    const pcmBuffer = Buffer.concat(pcmBuffers);

    // Write proper WAV file (header + PCM data)
    const wavHeader = this.buildWavHeader(pcmBuffer.length);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

    // Save to a temp WAV, then convert to MP3 via ffmpeg for broader compatibility
    const tmpWav = path.join(os.tmpdir(), `gemini_tts_${Date.now()}.wav`);
    await fs.writeFile(tmpWav, wavBuffer);

    // Convert to MP3
    const mp3Path = outputPath.replace(/\.[^.]+$/, '.mp3');
    await execAsync(
      `ffmpeg -y -i "${tmpWav}" -c:a libmp3lame -b:a 192k -ar 44100 "${mp3Path}"`,
      { timeout: 60000 }
    );
    await fs.unlink(tmpWav).catch(() => {});

    const stats = await fs.stat(mp3Path);
    this.logger.info(`TTS MP3 saved: ${mp3Path} (${(stats.size / 1024).toFixed(0)} KB)`);

    return mp3Path; // return actual path (may differ from outputPath extension)
  }
}

module.exports = { GeminiTTS };
