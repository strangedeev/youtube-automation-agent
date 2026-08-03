const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const sharp = require('sharp');
const axios = require('axios');
const { Logger } = require('./logger');

const execAsync = promisify(exec);

// Canvas dimensions — Shorts (portrait) is the default; pass format:'long' to
// the constructor for landscape long-form video.
const DIMENSIONS = {
  short: { width: 1080, height: 1920 },
  long:  { width: 1920, height: 1080 }
};

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','how','why','what','when','where','who','is','was','were','be','been',
  'being','have','has','had','do','does','did','will','would','could','should',
  'its','this','that','these','those','really','behind','directly','led','about',
  'into','over','after','before','between','through','which','during','not','than',
  'caused','design','flaw','counter','intuitive','instead','shutdown','surge'
]);

// Rotate through these so gameplay feels varied across videos
const GAMEPLAY_QUERIES = [
  'subway surfers',
  'minecraft parkour',
  'satisfying mobile game',
  'colorful casual game',
  'endless runner game',
  'mobile arcade game',
  'temple run gameplay',
  'satisfying game colorful'
];

class VideoAssembler {
  constructor(pexelsKey, pixabayKey, format = 'short') {
    this.pexelsKey  = pexelsKey  || null;
    this.pixabayKey = pixabayKey || null;
    this.format = format;
    const dims = DIMENSIONS[format] || DIMENSIONS.short;
    this.WIDTH  = dims.width;
    this.HEIGHT = dims.height;
    this.HALF_HEIGHT = Math.round(dims.height / 2);
    this.logger = new Logger('VideoAssembler');
  }

  escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  wrapText(text, charLimit = 22) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length > charLimit) {
        if (current) lines.push(current.trim());
        current = word;
      } else {
        current = (current + ' ' + word).trim();
      }
    }
    if (current) lines.push(current.trim());
    return lines.slice(0, 3);
  }

  // Follow redirects and return a Buffer
  fetchBuffer(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft === 0) return reject(new Error('Too many redirects'));
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(this.fetchBuffer(res.headers.location, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  // Fetch a JSON endpoint — apiKey is sent as Authorization header (Pexels style).
  // For Pixabay the key goes in the URL, so pass null here.
  fetchJson(url, apiKey) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const options = {
        headers: apiKey ? { Authorization: apiKey } : {},
        timeout: 15000
      };
      const req = mod.get(url, options, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  // ── Local gameplay clips ─────────────────────────────────────────────────

  // Pick a random local gameplay clip from data/gameplay/ and extract a
  // random segment from it — works with any length file (Shorts or long compilations).
  // Only uses files ≥1080p tall to avoid upscaling artefacts in the final video.
  async pickLocalGameplayClip(outputPath, clipDuration = 70) {
    const gameplayRoot = path.join(__dirname, '..', 'data', 'gameplay');
    const exts = new Set(['.mp4', '.webm', '.mkv', '.mov']);
    const MIN_HEIGHT = 1080;

    // Optional: restrict backgrounds to one subfolder (config/topics.json →
    // "backgroundFolder", e.g. "football"). Lets the channel switch its whole
    // background pool without deleting other clips. Falls back to all folders.
    let preferred = null;
    try {
      const cfgPath = path.join(__dirname, '..', 'config', 'topics.json');
      const cfgRaw = require('fs').existsSync(cfgPath)
        ? JSON.parse(require('fs').readFileSync(cfgPath, 'utf8')) : null;
      if (cfgRaw && cfgRaw.backgroundFolder) preferred = String(cfgRaw.backgroundFolder);
    } catch (_) {}

    // Collect all video files across all subfolders (or just the preferred one)
    const collectFrom = async (dirNames) => {
      const found = [];
      for (const dir of dirNames) {
        const sub = path.join(gameplayRoot, dir);
        const stat = await fs.stat(sub).catch(() => null);
        if (!stat?.isDirectory()) continue;
        const entries = await fs.readdir(sub);
        for (const f of entries) {
          if (exts.has(path.extname(f).toLowerCase())) {
            found.push(path.join(sub, f));
          }
        }
      }
      return found;
    };

    let candidates = [];
    try {
      const dirs = await fs.readdir(gameplayRoot);
      if (preferred && dirs.includes(preferred)) {
        candidates = await collectFrom([preferred]);
        if (candidates.length) {
          this.logger.info(`Using preferred background folder: ${preferred}/`);
        } else {
          this.logger.warn(`Preferred background folder "${preferred}/" is empty — using all folders`);
          candidates = await collectFrom(dirs);
        }
      } else {
        if (preferred) this.logger.warn(`Preferred background folder "${preferred}/" not found — using all folders`);
        candidates = await collectFrom(dirs);
      }
    } catch (err) {
      return false;
    }

    if (!candidates.length) return false;

    // Filter to only ≥1080p files — probe each for height
    const highRes = [];
    for (const f of candidates) {
      try {
        const { stdout } = await execAsync(
          `ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "${f}"`
        );
        const h = parseInt(stdout.trim(), 10);
        if (h >= MIN_HEIGHT) highRes.push(f);
        else this.logger.warn(`Skipping low-res file (${h}p): ${path.basename(f)}`);
      } catch (_) {}
    }

    // Fall back to all files if nothing passes the resolution check
    const files = highRes.length ? highRes : candidates;

    // Pick a random file
    const chosen = files[Math.floor(Math.random() * files.length)];
    this.logger.info(`Local gameplay: ${path.basename(chosen)}`);

    // Get its duration
    let totalDuration = 60;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${chosen}"`
      );
      totalDuration = parseFloat(stdout.trim()) || 60;
    } catch (_) {}

    // Pick a random start point, leaving room for clipDuration seconds
    const maxStart = Math.max(0, totalDuration - clipDuration);
    const startTime = Math.random() * maxStart;

    // Extract the segment using stream copy — zero re-encoding quality loss.
    // Input-side seeking (-ss before -i) lands on the nearest keyframe, which is
    // fine since we just need any random slice of gameplay.
    try {
      await execAsync(
        `ffmpeg -y -ss ${startTime.toFixed(2)} -i "${chosen}" -t ${clipDuration} ` +
        `-c:v copy -an -movflags +faststart "${outputPath}"`,
        { timeout: 60000 }
      );
      this.logger.info(`Local gameplay clip extracted (start: ${startTime.toFixed(0)}s, stream copy)`);
      return true;
    } catch (err) {
      // Stream copy failed (e.g. codec not compatible with mp4 container) — fall back to re-encode
      this.logger.warn(`Stream copy failed, re-encoding: ${err.message}`);
      try {
        await execAsync(
          `ffmpeg -y -ss ${startTime.toFixed(2)} -i "${chosen}" -t ${clipDuration} ` +
          `-c:v libx264 -preset fast -crf 18 -an -movflags +faststart "${outputPath}"`,
          { timeout: 120000 }
        );
        this.logger.info(`Local gameplay clip extracted (re-encoded fallback)`);
        return true;
      } catch (err2) {
        this.logger.warn(`Local gameplay extract failed: ${err2.message}`);
        return false;
      }
    }
  }

  // ── Pixabay ──────────────────────────────────────────────────────────────

  // Fetch a gameplay clip from Pixabay for the brainrot bottom half
  async fetchPixabayClip(outputPath) {
    if (!this.pixabayKey) return false;

    // Pick a random gameplay query so every video gets a different vibe
    const query = GAMEPLAY_QUERIES[Math.floor(Math.random() * GAMEPLAY_QUERIES.length)];
    this.logger.info(`Fetching Pixabay gameplay: "${query}"`);

    try {
      const url = `https://pixabay.com/api/videos/?key=${this.pixabayKey}&q=${encodeURIComponent(query)}&video_type=film&per_page=20`;
      const data = await this.fetchJson(url, null);

      if (!data.hits?.length) {
        this.logger.warn(`No Pixabay results for "${query}"`);
        return false;
      }

      // Pick randomly from the top 10 results so the same clip isn't reused every time
      const pool = data.hits.slice(0, 10);
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const videoUrl = pick.videos?.medium?.url || pick.videos?.small?.url || pick.videos?.large?.url;

      if (!videoUrl) return false;

      this.logger.info(`Downloading Pixabay clip...`);
      const buf = await this.fetchBuffer(videoUrl);
      await fs.writeFile(outputPath, buf);
      this.logger.info(`Pixabay gameplay saved (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
      return true;
    } catch (err) {
      this.logger.warn(`Pixabay fetch failed: ${err.message}`);
      return false;
    }
  }

  // ── Pexels ───────────────────────────────────────────────────────────────

  extractSearchKeywords(topic) {
    const words = topic
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));
    const seen = new Set();
    const keywords = [];
    for (const w of words) {
      if (!seen.has(w)) { seen.add(w); keywords.push(w); }
      if (keywords.length >= 3) break;
    }
    return keywords.join(' ') || 'nature cinematic';
  }

  extractMultipleKeywords(topic, count = 3) {
    const words = topic
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));
    const seen = new Set();
    const unique = [];
    for (const w of words) {
      if (!seen.has(w)) { seen.add(w); unique.push(w); }
    }
    if (unique.length === 0) {
      return ['nature cinematic', 'dramatic landscape', 'science abstract'].slice(0, count);
    }
    const queries = [];
    const step = Math.max(1, Math.floor(unique.length / count));
    for (let i = 0; i < count; i++) {
      const slice = unique.slice(i * step, i * step + 2).filter(Boolean);
      queries.push(slice.length > 0 ? slice.join(' ') : unique[i % unique.length]);
    }
    const fallbacks = ['cinematic dramatic', 'nature timelapse', 'abstract dark'];
    return queries.map((q, i) => q || fallbacks[i % fallbacks.length]).slice(0, count);
  }

  async fetchPexelsVideoByQuery(query, outputPath) {
    if (!this.pexelsKey) return false;
    const orientation = this.format === 'long' ? 'landscape' : 'portrait';
    try {
      const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&size=large&per_page=10`;
      const data = await this.fetchJson(url, this.pexelsKey);
      let videos = data.videos || [];
      if (!videos.length) {
        const fallbackQuery = query.split(' ')[0];
        if (fallbackQuery !== query) {
          const fb = await this.fetchJson(
            `https://api.pexels.com/videos/search?query=${encodeURIComponent(fallbackQuery)}&orientation=${orientation}&size=large&per_page=10`,
            this.pexelsKey
          );
          videos = fb.videos || [];
        }
      }
      if (!videos.length) return false;
      let selectedFile = null;
      for (const video of videos) {
        const files = (video.video_files || [])
          .filter(f => f.height && f.width && (this.format === 'long' ? f.width >= f.height : f.height >= f.width))
          .sort((a, b) => b.height - a.height);
        if (files.length) { selectedFile = files[0]; break; }
      }
      if (!selectedFile) return false;
      const buf = await this.fetchBuffer(selectedFile.link);
      await fs.writeFile(outputPath, buf);
      return true;
    } catch (err) {
      this.logger.warn(`Pexels clip failed for "${query}": ${err.message}`);
      return false;
    }
  }

  async fetchMultiplePexelsClips(topic, count, basePath) {
    if (!this.pexelsKey) return [];
    const queries = this.extractMultipleKeywords(topic, count);
    const dir  = path.dirname(basePath);
    const base = path.basename(basePath, path.extname(basePath));
    const clips = [];
    for (let i = 0; i < queries.length; i++) {
      const clipPath = path.join(dir, `${base}_clip${i}.mp4`);
      this.logger.info(`Fetching clip ${i + 1}/${queries.length} — query: "${queries[i]}"`);
      const ok = await this.fetchPexelsVideoByQuery(queries[i], clipPath);
      if (ok) clips.push(clipPath);
    }
    return clips;
  }

  async fetchPexelsVideo(topic, outputPath) {
    const query = this.extractSearchKeywords(topic);
    this.logger.info(`Searching Pexels for: "${query}"`);
    return this.fetchPexelsVideoByQuery(query, outputPath);
  }

  // ── Backgrounds & overlays ───────────────────────────────────────────────

  async fetchAIImage(topic, outputPath) {
    const prompt = encodeURIComponent(
      `cinematic dramatic photorealistic scene: ${topic}. Epic lighting, highly detailed, dark atmospheric, 4K, no text`
    );
    const url = `https://image.pollinations.ai/prompt/${prompt}?width=${this.WIDTH}&height=${this.HEIGHT}&nologo=true&seed=${Date.now()}`;
    try {
      this.logger.info('Fetching AI background image (Pollinations)...');
      const buf = await this.fetchBuffer(url);
      await sharp(buf)
        .resize(this.WIDTH, this.HEIGHT, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 90 })
        .toFile(outputPath);
      this.logger.info('AI background image ready');
      return true;
    } catch (err) {
      this.logger.warn(`AI image fetch failed: ${err.message}`);
      return false;
    }
  }

  // Full-frame text overlay (used in non-brainrot mode)
  async createTextOverlay(title, outputPath) {
    const lines = this.wrapText(title, 22);
    const lineHeight = 100;
    const startY = this.HEIGHT / 2 - ((lines.length - 1) * lineHeight) / 2;
    const titleSvg = lines.map((line, i) =>
      `<text x="${this.WIDTH / 2}" y="${startY + i * lineHeight}"
        font-family="Noto Sans Devanagari, Arial" font-size="80" font-weight="bold"
        fill="white" text-anchor="middle" dominant-baseline="middle"
        filter="url(#shadow)">${this.escapeXml(line)}</text>`
    ).join('\n');
    const svg = `<svg width="${this.WIDTH}" height="${this.HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow">
          <feDropShadow dx="0" dy="3" stdDeviation="8" flood-color="#000000" flood-opacity="0.9"/>
        </filter>
        <filter id="glow">
          <feGaussianBlur stdDeviation="6" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${titleSvg}
      <text x="${this.WIDTH / 2}" y="${this.HEIGHT - 100}"
        font-family="Noto Sans Devanagari, Arial" font-size="42" font-weight="bold"
        fill="white" text-anchor="middle" filter="url(#glow)" opacity="0.9">Follow for more 🔥</text>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(outputPath);
    return outputPath;
  }

  // Brainrot overlay — full screen (1080×1920), placed over gameplay.
  // Title sits in the upper third; CTA anchored near the bottom.
  async createBrainrotOverlay(title, outputPath) {
    const lines = this.wrapText(title, 22);
    const lineHeight = 95;
    const blockH = lines.length * lineHeight;
    const startY = 320 + lineHeight; // upper third

    const titleSvg = lines.map((line, i) =>
      `<text x="${this.WIDTH / 2}" y="${startY + i * lineHeight}"
        font-family="Noto Sans Devanagari, Arial" font-size="80" font-weight="bold"
        fill="white" text-anchor="middle" dominant-baseline="middle"
        filter="url(#shadow)">${this.escapeXml(line)}</text>`
    ).join('\n');

    // Dark semi-transparent bar behind title for readability over busy gameplay
    const barTop    = startY - lineHeight - 20;
    const barBottom = startY + blockH + 10;

    const svg = `<svg width="${this.WIDTH}" height="${this.HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow">
          <feDropShadow dx="0" dy="3" stdDeviation="10" flood-color="#000000" flood-opacity="0.95"/>
        </filter>
        <filter id="glow">
          <feGaussianBlur stdDeviation="6" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect x="0" y="${barTop}" width="${this.WIDTH}" height="${barBottom - barTop}" fill="black" opacity="0.5"/>
      ${titleSvg}
      <text x="${this.WIDTH / 2}" y="${this.HEIGHT - 80}"
        font-family="Noto Sans Devanagari, Arial" font-size="44" font-weight="bold"
        fill="#FFD700" text-anchor="middle" filter="url(#shadow)" opacity="0.95">Follow for more 🔥</text>
    </svg>`;

    await sharp(Buffer.from(svg)).png().toFile(outputPath);
    return outputPath;
  }

  // Plain dark gradient — used as the top half when no video/image is available in brainrot mode
  async createDarkHalfBackground(outputPath) {
    const svg = `<svg width="${this.WIDTH}" height="${this.HALF_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#0d0d1a"/>
          <stop offset="100%" style="stop-color:#1a0a2e"/>
        </linearGradient>
      </defs>
      <rect width="${this.WIDTH}" height="${this.HALF_HEIGHT}" fill="url(#bg)"/>
    </svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(outputPath);
    return outputPath;
  }

  // Full-frame gradient fallback (non-brainrot, text baked in)
  async createGradientBackground(title, outputPath) {
    const lines = this.wrapText(title, 22);
    const lineHeight = 100;
    const startY = this.HEIGHT / 2 - ((lines.length - 1) * lineHeight) / 2;
    const titleSvg = lines.map((line, i) =>
      `<text x="${this.WIDTH / 2}" y="${startY + i * lineHeight}"
        font-family="Noto Sans Devanagari, Arial" font-size="80" font-weight="bold"
        fill="white" text-anchor="middle" dominant-baseline="middle"
        filter="url(#shadow)">${this.escapeXml(line)}</text>`
    ).join('\n');
    const svg = `<svg width="${this.WIDTH}" height="${this.HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#1a1a2e"/>
          <stop offset="40%" style="stop-color:#16213e"/>
          <stop offset="70%" style="stop-color:#0f3460"/>
          <stop offset="100%" style="stop-color:#533483"/>
        </linearGradient>
        <filter id="shadow">
          <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000000" flood-opacity="0.7"/>
        </filter>
        <filter id="glow">
          <feGaussianBlur stdDeviation="6" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <rect width="${this.WIDTH}" height="${this.HEIGHT}" fill="url(#bg)"/>
      <circle cx="0" cy="400" r="350" fill="#ffffff" opacity="0.03"/>
      <circle cx="${this.WIDTH}" cy="${this.HEIGHT - 400}" r="400" fill="#ffffff" opacity="0.03"/>
      ${titleSvg}
      <text x="${this.WIDTH / 2}" y="${this.HEIGHT - 100}"
        font-family="Noto Sans Devanagari, Arial" font-size="42" font-weight="bold"
        fill="white" text-anchor="middle" filter="url(#glow)" opacity="0.9">Follow for more 🔥</text>
    </svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(outputPath);
    return outputPath;
  }

  // ── createBackground ─────────────────────────────────────────────────────
  // Returns one of:
  //   { type:'brainrot', gameplayPath, overlayPath }   ← full-screen gameplay
  //   { type:'video',    bgPaths, overlayPath }
  //   { type:'image',    bgPath,  overlayPath }
  //   { type:'gradient', bgPath,  overlayPath:null }

  async createBackground(topic, title, basePath) {
    const dir  = path.dirname(basePath);
    const base = path.basename(basePath, path.extname(basePath));
    const imageBgPath  = path.join(dir, base + '_bg.jpg');
    const overlayPath  = path.join(dir, base + '_overlay.png');
    const gameplayPath = path.join(dir, base + '_gameplay.mp4');

    // ── BRAINROT MODE (local clips first, Pixabay fallback) ─────────────
    // Portrait-only "brainrot" gameplay aesthetic — skip entirely for long-form,
    // which needs landscape B-roll, not vertical Subway Surfers-style clips.
    if (this.format !== 'long') {
      // Try local gameplay folder first — faster, no API quota, better quality
      let gameplayOk = await this.pickLocalGameplayClip(gameplayPath);

      // Fall back to Pixabay if no local clips available
      if (!gameplayOk && this.pixabayKey) {
        this.logger.info('No local gameplay clips — trying Pixabay...');
        gameplayOk = await this.fetchPixabayClip(gameplayPath);
      }

      if (gameplayOk) {
        this.logger.info('Brainrot mode — full-screen gameplay, no overlay');
        return { type: 'brainrot', gameplayPath };
      }
      this.logger.warn('No gameplay source available — falling back to standard mode');
    }

    // ── STANDARD MODE ────────────────────────────────────────────────────
    const clips = await this.fetchMultiplePexelsClips(topic, 3, basePath);
    if (clips.length >= 1) {
      await this.createTextOverlay(title, overlayPath);
      this.logger.info(`Standard mode — ${clips.length} Pexels clip(s)`);
      return { type: 'video', bgPaths: clips, overlayPath };
    }

    const aiOk = await this.fetchAIImage(topic, imageBgPath);
    if (aiOk) {
      await this.createTextOverlay(title, overlayPath);
      return { type: 'image', bgPath: imageBgPath, overlayPath };
    }

    await this.createGradientBackground(title, imageBgPath);
    return { type: 'gradient', bgPath: imageBgPath, overlayPath: null };
  }

  // ── Thumbnail ────────────────────────────────────────────────────────────

  // Generate a 1280×720 custom thumbnail:
  //   • extract a sharp frame from the gameplay video
  //   • overlay the Hindi title in large bold text with a dark gradient behind it
  // This gets uploaded to YouTube separately from the video — the video itself
  // stays pure gameplay with no text baked in.
  // Build a Pollinations.ai image prompt from the story title.
  // The goal is a cinematic, emotionally resonant scene — no text in the image,
  // we overlay our own title text on top.
  buildThumbnailPrompt(title) {
    const t = title.toLowerCase();

    // Map story themes to visual styles
    let style = 'dramatic cinematic scene, dark moody lighting, photorealistic, 4k';

    if (/secret|hidden|fake|double life|bunker|camera|surveil/.test(t)) {
      style = 'dark dramatic scene, shadows and secrets, spy thriller atmosphere, mysterious lighting, cinematic 4k';
    } else if (/cheat|betray|husband|wife|fiancé|marriage|affair/.test(t)) {
      style = 'emotional betrayal scene, dramatic lighting, couple silhouette, heartbreak atmosphere, cinematic 4k';
    } else if (/boss|fired|workplace|cowork|job|office/.test(t)) {
      style = 'tense office confrontation, dramatic corporate setting, power struggle, cinematic 4k';
    } else if (/inherit|safe|locked|family|destroy/.test(t)) {
      style = 'mysterious antique safe, dramatic revelation, family secrets, dark cinematic 4k';
    } else if (/neighbor|backyard|midnight|auction/.test(t)) {
      style = 'suburban mystery, nighttime drama, dark neighborhood, cinematic thriller 4k';
    } else if (/sister|brother|parent|family/.test(t)) {
      style = 'family drama, emotional confrontation, strained relationships, cinematic 4k';
    } else if (/therapist|doctor|professional/.test(t)) {
      style = 'tense therapy session, trust betrayal, professional setting, dramatic lighting, cinematic 4k';
    } else if (/identity|stole|impersonation/.test(t)) {
      style = 'identity theft thriller, shadowy figure, documents and secrets, cinematic 4k';
    }

    return `${style}, no text, no words, no letters, no UI, movie poster quality, highly detailed`;
  }

  // Search Pexels for a landscape PHOTO and return its bytes, or null.
  // Used for thumbnails — real, license-clear imagery (no Content-ID, no AI cost).
  async fetchPexelsPhotoBuffer(query) {
    if (!this.pexelsKey) return null;
    try {
      const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
                  `&orientation=landscape&size=large&per_page=15`;
      const data = await this.fetchJson(url, this.pexelsKey);
      const photos = data?.photos || [];
      if (!photos.length) return null;
      // Pick from the top few for variety; prefer the large2x/landscape render.
      const pick = photos[Math.floor(Math.random() * Math.min(8, photos.length))];
      const imgUrl = pick.src?.landscape || pick.src?.large2x || pick.src?.large || pick.src?.original;
      if (!imgUrl) return null;
      const resp = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 20000 });
      return Buffer.from(resp.data);
    } catch (err) {
      this.logger.warn(`Pexels photo failed for "${query}": ${err.message}`);
      return null;
    }
  }

  // Turn a clickbait title into a clean image search query (keywords + anchor).
  buildThumbnailQuery(title) {
    const stop = new Set(['the','a','an','of','to','in','on','and','that','this','was','were',
      'is','are','his','her','him','she','he','they','it','for','with','what','how','why',
      'who','ever','one','no','ended','made','facts','things','about','will','make','never',
      'most','people','out','you','your','their','never','really','actually']);
    const words = String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !stop.has(w)).slice(0, 3);
    return words.join(' ').trim() || 'science history dramatic';
  }

  async generateThumbnail(videoPath, title, outputPath) {
    const THUMB_W = 1280;
    const THUMB_H = 720;

    try {
      // 1. Fetch a real football photo from Pexels (license-clear, on-theme).
      const query = this.buildThumbnailQuery(title);
      this.logger.info(`Fetching Pexels thumbnail photo: "${query}"`);
      let bgImageBuffer = await this.fetchPexelsPhotoBuffer(query);
      if (!bgImageBuffer) bgImageBuffer = await this.fetchPexelsPhotoBuffer('science history dramatic');
      if (!bgImageBuffer) throw new Error('No Pexels photo available');

      // 2. Build SVG text overlay — title centred in lower third, bold white with shadow
      const lines      = this.wrapText(title, 24);
      const lineHeight = 80;
      const startY     = THUMB_H - (lines.length * lineHeight) - 60;
      const gradTop    = startY - lineHeight;
      const gradH      = THUMB_H - gradTop;

      const titleSvg = lines.map((line, i) =>
        `<text x="${THUMB_W / 2}" y="${startY + i * lineHeight}"
          font-family="Arial Black, Arial" font-size="68" font-weight="900"
          fill="white" text-anchor="middle" dominant-baseline="middle"
          filter="url(#shadow)">${this.escapeXml(line)}</text>`
      ).join('\n');

      const svg = `<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="black" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="0.82"/>
          </linearGradient>
          <filter id="shadow">
            <feDropShadow dx="0" dy="3" stdDeviation="8" flood-color="#000000" flood-opacity="0.95"/>
          </filter>
        </defs>
        <rect x="0" y="${gradTop}" width="${THUMB_W}" height="${gradH}" fill="url(#grad)"/>
        ${titleSvg}
      </svg>`;

      // 3. Composite the SVG text over the AI background
      await sharp(bgImageBuffer)
        .resize(THUMB_W, THUMB_H, { fit: 'cover', position: 'centre' })
        .composite([{ input: Buffer.from(svg), blend: 'over' }])
        .jpeg({ quality: 92 })
        .toFile(outputPath);

      this.logger.info(`Pexels thumbnail generated: ${outputPath}`);
      return outputPath;
    } catch (err) {
      // Fallback: extract a frame from the background video
      this.logger.warn(`Pexels thumbnail failed (${err.message}), falling back to video frame`);
      return this.generateThumbnailFromFrame(videoPath, title, outputPath);
    }
  }

  async generateThumbnailFromFrame(videoPath, title, outputPath) {
    const THUMB_W = 1280;
    const THUMB_H = 720;

    try {
      let totalDuration = 30;
      try {
        const { stdout } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
        );
        totalDuration = parseFloat(stdout.trim()) || 30;
      } catch (_) {}

      const seekTime = (totalDuration * 0.2).toFixed(2);
      const framePath = outputPath.replace(/\.[^.]+$/, '_frame.jpg');

      await execAsync(
        `ffmpeg -y -ss ${seekTime} -i "${videoPath}" -vframes 1 ` +
        `-vf "scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H}" ` +
        `-q:v 2 "${framePath}"`,
        { timeout: 30000 }
      );

      const lines      = this.wrapText(title, 24);
      const lineHeight = 80;
      const startY     = THUMB_H - (lines.length * lineHeight) - 60;
      const gradTop    = startY - lineHeight;
      const gradH      = THUMB_H - gradTop;

      const titleSvg = lines.map((line, i) =>
        `<text x="${THUMB_W / 2}" y="${startY + i * lineHeight}"
          font-family="Arial Black, Arial" font-size="68" font-weight="900"
          fill="white" text-anchor="middle" dominant-baseline="middle"
          filter="url(#shadow)">${this.escapeXml(line)}</text>`
      ).join('\n');

      const svg = `<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="black" stop-opacity="0"/>
            <stop offset="100%" stop-color="black" stop-opacity="0.82"/>
          </linearGradient>
          <filter id="shadow">
            <feDropShadow dx="0" dy="3" stdDeviation="8" flood-color="#000000" flood-opacity="0.95"/>
          </filter>
        </defs>
        <rect x="0" y="${gradTop}" width="${THUMB_W}" height="${gradH}" fill="url(#grad)"/>
        ${titleSvg}
      </svg>`;

      await sharp(framePath)
        .resize(THUMB_W, THUMB_H, { fit: 'cover', position: 'centre' })
        .composite([{ input: Buffer.from(svg), blend: 'over' }])
        .jpeg({ quality: 92 })
        .toFile(outputPath);

      await fs.unlink(framePath).catch(() => {});

      this.logger.info(`Thumbnail generated from frame: ${outputPath}`);
      return outputPath;
    } catch (err) {
      this.logger.warn(`Thumbnail generation failed: ${err.message}`);
      return null;
    }
  }

  // ── assemble ─────────────────────────────────────────────────────────────

  async getAudioDuration(audioPath) {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
    ).catch(() => ({ stdout: '60' }));
    return parseFloat(stdout.trim()) || 60;
  }

  // Build the ffmpeg filter string + input args for a stack of content clips
  // (used for both standard multi-clip and brainrot top half)
  _buildMultiClipFilter(clips, targetH, darkened = true) {
    const n = clips.length;
    const filterParts = clips.map((_, i) => {
      const base = `[${i}:v]scale=${this.WIDTH}:${targetH}:force_original_aspect_ratio=increase,crop=${this.WIDTH}:${targetH},setsar=1`;
      return darkened
        ? `${base},lutyuv=y=val*0.5:u=val:v=val[v${i}]`
        : `${base}[v${i}]`;
    });
    const concatIn = clips.map((_, i) => `[v${i}]`).join('');
    return { filterParts, concatIn, n };
  }

  async assemble(bgResult, audioPath, outputPath, extras = {}) {
    this.logger.info(`Assembling video (type: ${bgResult.type}${bgResult.topType ? '/' + bgResult.topType : ''})...`);
    const rawDuration = await this.getAudioDuration(audioPath);

    // Hard cap at 175s for Shorts — YouTube Shorts limit is 180s and we want a
    // small buffer. Long-form has no such cap (YouTube's long-form max is 12h).
    const MAX_SHORTS_DURATION = 175;
    const duration = this.format === 'long'
      ? rawDuration
      : Math.min(rawDuration, MAX_SHORTS_DURATION);
    if (this.format !== 'long' && rawDuration > MAX_SHORTS_DURATION) {
      this.logger.warn(`Audio is ${rawDuration.toFixed(1)}s — capping to ${MAX_SHORTS_DURATION}s to stay within YouTube Shorts limit`);
    }

    // Phase 2 overlays (all optional — pipeline degrades gracefully if absent)
    const { captionTrack, cardPath, cardDuration = 5, musicPath } = extras;

    let cmd;

    // ── BRAINROT: full-screen background + reddit card + captions + music ──
    if (bgResult.type === 'brainrot') {
      const { gameplayPath } = bgResult;

      // Build inputs dynamically and track their indices
      const inputs = [
        `-stream_loop -1 -i "${gameplayPath}"`,  // 0: background video
        `-i "${audioPath}"`                       // 1: narration
      ];
      let idx = 2;
      let musicIdx = -1, capIdx = -1, cardIdx = -1;
      if (musicPath)    { inputs.push(`-stream_loop -1 -i "${musicPath}"`); musicIdx = idx++; }
      if (captionTrack) { inputs.push(`-i "${captionTrack}"`);              capIdx  = idx++; }
      if (cardPath)     { inputs.push(`-loop 1 -t ${cardDuration} -i "${cardPath}"`); cardIdx = idx++; }

      // Video filter chain: scale/crop bg → card overlay (intro) → caption overlay
      const vparts = [`[0:v]scale=${this.WIDTH}:${this.HEIGHT}:force_original_aspect_ratio=increase,crop=${this.WIDTH}:${this.HEIGHT},setsar=1[base]`];
      let vlabel = '[base]';
      if (cardIdx >= 0) {
        // Card centred horizontally, upper third, visible only for the intro
        vparts.push(`${vlabel}[${cardIdx}:v]overlay=(W-w)/2:180:enable='between(t,0,${cardDuration})'[vcard]`);
        vlabel = '[vcard]';
      }
      if (capIdx >= 0) {
        // Caption track is full-frame with alpha — overlay across the whole video
        vparts.push(`${vlabel}[${capIdx}:v]overlay=0:0[vcap]`);
        vlabel = '[vcap]';
      }

      // Audio: narration, with optional low music bed mixed under it
      let amap;
      if (musicIdx >= 0) {
        vparts.push(`[${musicIdx}:a]volume=0.12[mus]`);
        vparts.push(`[1:a][mus]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
        amap = '[aout]';
      } else {
        amap = '1:a';
      }

      cmd = [
        'ffmpeg -y',
        ...inputs,
        '-filter_complex',
        `"${vparts.join(';')}"`,
        `-map "${vlabel}" -map "${amap}"`,
        '-c:v libx264 -preset fast -crf 18',
        '-c:a aac -b:a 192k -ar 44100',
        '-pix_fmt yuv420p',
        `-t ${duration}`,
        '-movflags +faststart',
        `"${outputPath}"`
      ].join(' ');

    // ── SEGMENTS: per-chapter clips cut to narration beats + captions + music ──
    // Long-form per-beat path: bgResult.clips = [{ path, duration }], one clip
    // per chapter, each shown for its share of the narration. Unlike 'brainrot'
    // (one continuous reel) the visuals change with the story.
    } else if (bgResult.type === 'segments') {
      const clips = bgResult.clips || [];
      const n = clips.length;

      const inputs = clips.map(c =>
        `-stream_loop -1 -t ${Number(c.duration).toFixed(3)} -i "${c.path}"`);
      inputs.push(`-i "${audioPath}"`);            // n: narration
      const audioIdx = n;
      let idx = n + 1;
      let musicIdx = -1, capIdx = -1;
      if (musicPath)    { inputs.push(`-stream_loop -1 -i "${musicPath}"`); musicIdx = idx++; }
      if (captionTrack) { inputs.push(`-i "${captionTrack}"`);              capIdx  = idx++; }

      // Scale/crop/darken each clip, then concat in order
      const vparts = clips.map((_, i) =>
        `[${i}:v]scale=${this.WIDTH}:${this.HEIGHT}:force_original_aspect_ratio=increase,crop=${this.WIDTH}:${this.HEIGHT},setsar=1,lutyuv=y=val*0.55:u=val:v=val[v${i}]`);
      const concatIn = clips.map((_, i) => `[v${i}]`).join('');
      vparts.push(`${concatIn}concat=n=${n}:v=1:a=0[cat]`);
      let vlabel = '[cat]';
      if (capIdx >= 0) {
        vparts.push(`${vlabel}[${capIdx}:v]overlay=0:0[vcap]`);
        vlabel = '[vcap]';
      }

      let amap;
      if (musicIdx >= 0) {
        vparts.push(`[${musicIdx}:a]volume=0.12[mus]`);
        vparts.push(`[${audioIdx}:a][mus]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
        amap = '[aout]';
      } else {
        amap = `${audioIdx}:a`;
      }

      cmd = [
        'ffmpeg -y',
        ...inputs,
        '-filter_complex',
        `"${vparts.join(';')}"`,
        `-map "${vlabel}" -map "${amap}"`,
        // veryfast keeps a 15-20min long-form encode well inside the timeout.
        // crf 20 (vs 18) roughly halves a 15min file to ~500MB with negligible
        // perceptual loss on B-roll — and YouTube re-encodes on upload anyway.
        '-c:v libx264 -preset veryfast -crf 20',
        '-c:a aac -b:a 192k -ar 44100',
        '-pix_fmt yuv420p',
        `-t ${duration}`,
        '-movflags +faststart',
        `"${outputPath}"`
      ].join(' ');

    // ── STANDARD: full-frame video (multi-clip) ───────────────────────────
    } else if (bgResult.type === 'video') {
      const clips = bgResult.bgPaths || (bgResult.bgPath ? [bgResult.bgPath] : []);
      const n = clips.length;

      if (n > 1) {
        const segDuration = (duration / n).toFixed(3);
        const inputs = clips.map(p => `-stream_loop -1 -t ${segDuration} -i "${p}"`).join(' ');
        const { filterParts, concatIn } = this._buildMultiClipFilter(clips, this.HEIGHT, true);
        const audioIdx   = n;
        const overlayIdx = n + 1;
        const filterStr = [
          ...filterParts,
          `${concatIn}concat=n=${n}:v=1:a=0[concat]`,
          `[concat][${overlayIdx}:v]overlay=0:0[out]`
        ].join(';');
        cmd = [
          'ffmpeg -y', inputs,
          `-i "${audioPath}"`,
          `-i "${bgResult.overlayPath}"`,
          '-filter_complex', `"${filterStr}"`,
          `-map "[out]" -map "${audioIdx}:a"`,
          '-c:v libx264 -preset veryfast -crf 23',
          '-c:a aac -b:a 192k -ar 44100',
          '-pix_fmt yuv420p', `-t ${duration}`,
          '-movflags +faststart', `"${outputPath}"`
        ].join(' ');
      } else {
        const bgPath = clips[0];
        cmd = [
          'ffmpeg -y',
          `-stream_loop -1 -i "${bgPath}"`,
          `-i "${audioPath}"`,
          `-i "${bgResult.overlayPath}"`,
          '-filter_complex',
          `"[0:v]scale=${this.WIDTH}:${this.HEIGHT}:force_original_aspect_ratio=increase,crop=${this.WIDTH}:${this.HEIGHT},setsar=1,lutyuv=y=val*0.5:u=val:v=val[darkened];[darkened][2:v]overlay=0:0[out]"`,
          '-map "[out]" -map "1:a"',
          '-c:v libx264 -preset veryfast -crf 23',
          '-c:a aac -b:a 192k -ar 44100',
          '-pix_fmt yuv420p', `-t ${duration}`,
          '-movflags +faststart', `"${outputPath}"`
        ].join(' ');
      }

    // ── STANDARD: full-frame AI image (Ken Burns) ─────────────────────────
    } else if (bgResult.type === 'image') {
      const scaledW = Math.round(this.WIDTH  * 1.2);
      const scaledH = Math.round(this.HEIGHT * 1.2);
      cmd = [
        'ffmpeg -y',
        `-loop 1 -i "${bgResult.bgPath}"`,
        `-i "${audioPath}"`,
        `-i "${bgResult.overlayPath}"`,
        '-filter_complex',
        `"[0:v]scale=${scaledW}:${scaledH},crop=${this.WIDTH}:${this.HEIGHT}:x='(${scaledW}-${this.WIDTH})*t/${duration}':y='(${scaledH}-${this.HEIGHT})/2',setsar=1[panned];[panned][2:v]overlay=0:0[out]"`,
        '-map "[out]" -map "1:a"',
        '-c:v libx264 -preset veryfast -crf 23',
        '-c:a aac -b:a 192k -ar 44100',
        '-pix_fmt yuv420p', `-t ${duration}`,
        '-movflags +faststart', `"${outputPath}"`
      ].join(' ');

    // ── STANDARD: gradient static fallback ───────────────────────────────
    } else {
      cmd = [
        'ffmpeg -y',
        `-loop 1 -i "${bgResult.bgPath}"`,
        `-i "${audioPath}"`,
        '-c:v libx264 -tune stillimage -preset veryfast -crf 23',
        '-c:a aac -b:a 192k -ar 44100',
        '-pix_fmt yuv420p', `-t ${duration}`,
        '-movflags +faststart', `"${outputPath}"`
      ].join(' ');
    }

    // Timeout must scale with the video: a 15-20min 1080p long-form encode can
    // take 10-20+ min, so a fixed 10min limit killed long-form mid-encode.
    // Allow ~6x realtime, floor 10min. Large maxBuffer so ffmpeg's per-frame
    // stderr progress on a long encode never overflows the default 1MB.
    const encodeTimeout = Math.max(600000, Math.round(duration * 6000));
    await execAsync(cmd, { timeout: encodeTimeout, maxBuffer: 64 * 1024 * 1024 });

    const stats = await fs.stat(outputPath);
    this.logger.info(`Video assembled: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    return { path: outputPath, size: stats.size, duration };
  }
}

module.exports = { VideoAssembler };
