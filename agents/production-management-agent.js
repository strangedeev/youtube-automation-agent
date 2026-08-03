const path = require('path');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { GeminiTTS } = require('../utils/gemini-tts');
const { EdgeTTS } = require('../utils/edge-tts');
const { VideoAssembler } = require('../utils/video-assembler');
const { CaptionRenderer } = require('../utils/caption-renderer');
const { RedditCard } = require('../utils/reddit-card');

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials);
    // Caption renderer + video assembler are format-aware (portrait Shorts vs
    // landscape long-form) — keep one instance of each per format.
    this.captionRenderers = {
      short: new CaptionRenderer('short'),
      long:  new CaptionRenderer('long')
    };
    this.redditCard = new RedditCard();
    this.channelName = credentials.credentials?.channel?.channelName || 'Storytime';

    const geminiKey = credentials.credentials?.gemini?.apiKey;
    if (geminiKey) {
      this.tts = new GeminiTTS(geminiKey);
      const genAI = new GoogleGenerativeAI(geminiKey);
      this.gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
      this.logger.info('Gemini TTS + text model initialized');
    }
    // edge-tts (free, no quota) narrates long-form — Gemini TTS free tier is
    // only 15 requests/day, which a chunked 3000-word script would exhaust.
    this.edgeTTS = new EdgeTTS();
    const pexelsKey = credentials.credentials?.pexels?.apiKey;
    const pixabayKey = credentials.credentials?.pixabay?.apiKey;
    this.videoAssemblers = {
      short: new VideoAssembler(pexelsKey, pixabayKey, 'short'),
      long:  new VideoAssembler(pexelsKey, pixabayKey, 'long')
    };
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData, statusCallback = null) {
    this._statusCallback = typeof statusCallback === 'function' ? statusCallback : () => {};
    try {
      this.logger.info('Processing content for production...');

      const { strategy, script, thumbnail, seo } = contentData;

      // Create production entry
      const productionId = this.generateProductionId();

      const productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        createdAt: new Date().toISOString()
      };
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);
      
      // Generate video content
      await this.generateVideoContent(productionData);

      // Generate audio narration
      this._statusCallback('🎙️ Generating voiceover with Aoede…');
      await this.generateAudioNarration(productionData);

      // Generate captions (whisper transcription)
      this._statusCallback('📝 Transcribing audio for captions…');
      await this.generateCaptions(productionData);

      // Assemble — MPT footage fetch + ffmpeg (sub-steps update status internally)
      await this.assembleVideo(productionData);
      
      // Mark as ready
      productionData.status = 'ready';
      productionData.timeline.readyForUpload = new Date().toISOString();
      
      await this.db.updateProductionData(productionData);
      
      this.logger.info(`Content processing complete: ${productionId}`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    // If Gemini wrote a clean narration field, use it directly — no wrapping, no filler.
    // This is the word-for-word text the TTS should speak.
    if (script.narration && script.narration.trim().length > 20) {
      return script.narration.trim();
    }

    // Legacy fallback for older scripts without narration field
    let ttsText = '';

    // Hook
    if (script.hook?.text) {
      ttsText += `${script.hook.text}\n\n`;
    }

    // Introduction greeting only — skip the hardcoded filler lines
    if (script.introduction?.greeting) {
      ttsText += `${script.introduction.greeting}\n\n`;
    }

    // Main content — sections
    if (script.mainContent?.sections) {
      script.mainContent.sections.forEach(section => {
        // Skip section header labels — they read out badly as "Section 1: undefined"
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) {
              ttsText += `${line}\n`;
            }
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += `${step.title}. ${step.description}\n`;
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        ttsText += '\n';
      });
    }

    // Conclusion
    if (script.conclusion?.finalThought) {
      ttsText += `${script.conclusion.finalThought}\n\n`;
    }

    // CTA — just the subscribe line if set, skip the rest
    if (script.callToAction?.subscribe) {
      ttsText += `${script.callToAction.subscribe}\n`;
    }

    return ttsText.trim();
  }

  async processThumbnail(thumbnail) {
    try {
      // Try to generate AI thumbnail first
      const script = thumbnail.script || { title: 'Ethereal Dreamscript Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(script, 'ethereal');
      
      return {
        path: aiThumbnail.path,
        originalPath: thumbnail.path,
        dimensions: aiThumbnail.dimensions,
        fileSize: aiThumbnail.fileSize,
        generatedWith: 'AI'
      };
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
      
      // Fallback to original processing
      const productionThumbnailPath = path.join(
        __dirname, '..', 'data', 'assets', 
        `thumbnail_${Date.now()}.jpg`
      );
      
      if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
        const originalBuffer = await fs.readFile(thumbnail.path);
        await fs.writeFile(productionThumbnailPath, originalBuffer);
      } else {
        // Create placeholder
        await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
      }
      
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0
      };
    }
  }

  calculatePublishTime(strategy) {
    // Use strategy's recommended time or calculate optimal time
    if (strategy.bestPublishTime) {
      return strategy.bestPublishTime;
    }
    
    // Default: next optimal publishing window
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50; // Base priority
    
    // Adjust based on estimated views
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    
    // Adjust based on trend score
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) {
      priority += 10;
    }
    
    // Time sensitivity
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    
    return Math.min(100, priority);
  }

  async generateVideoContent(productionData) {
    this.logger.info('Generating AI video content...');
    
    try {
      const { strategy, script } = productionData;
      
      // Generate visual assets using DALL-E
      const visualPrompts = this.createVisualPromptsFromScript(script);
      const visualAssets = [];
      
      for (const prompt of visualPrompts) {
        const assets = await this.aiVideoGenerator.generateVisualAssets(prompt, 'ethereal', 1);
        visualAssets.push(...assets);
      }
      
      productionData.assets.video = {
        visualAssets: visualAssets,
        duration: productionData.estimatedDuration,
        format: 'mp4',
        resolution: '1920x1080',
        fps: 30,
        generatedWith: 'AI'
      };
      
      productionData.timeline.videoGenerated = new Date().toISOString();
      
      return visualAssets;
    } catch (error) {
      this.logger.error('AI video content generation failed:', error);
      // Fallback to placeholder
      return await this.createVideoElements(productionData);
    }
  }

  async createVideoElements(productionData) {
    const { script } = productionData;
    const elements = [];
    
    // Title slide
    elements.push({
      type: 'title_slide',
      content: script.title,
      duration: 3,
      style: 'modern',
      animation: 'fade_in'
    });
    
    // Content sections
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        // Section title
        elements.push({
          type: 'section_title',
          content: section.title,
          duration: 2,
          style: 'minimal',
          animation: 'slide_in'
        });
        
        // Content visuals
        if (section.type === 'list_items' && section.items) {
          section.items.forEach(item => {
            elements.push({
              type: 'list_item',
              content: {
                number: item.number,
                title: item.title,
                description: item.description
              },
              duration: 15,
              style: 'countdown',
              animation: 'zoom_in'
            });
          });
        } else if (section.type === 'solution_steps' && section.steps) {
          section.steps.forEach(step => {
            elements.push({
              type: 'step',
              content: {
                number: step.number,
                title: step.title,
                description: step.description
              },
              duration: 20,
              style: 'tutorial',
              animation: 'step_by_step'
            });
          });
        } else {
          // Generic content slide
          elements.push({
            type: 'content_slide',
            content: section.title,
            duration: section.duration || 30,
            style: 'informative',
            animation: 'fade_transition'
          });
        }
      });
    }
    
    // Conclusion slide
    elements.push({
      type: 'conclusion',
      content: 'Key Takeaways',
      duration: 5,
      style: 'summary',
      animation: 'reveal'
    });
    
    // Subscribe reminder
    elements.push({
      type: 'subscribe_reminder',
      content: 'Subscribe for More!',
      duration: 3,
      style: 'call_to_action',
      animation: 'bounce'
    });
    
    return elements;
  }

  async generateAudioNarration(productionData) {
    // Long-form uses edge-tts (free, unlimited); Shorts stay on Gemini TTS.
    const isLong = productionData.strategy?.format === 'long';
    const engine = isLong ? this.edgeTTS : this.tts;
    const engineName = isLong ? 'edge-tts' : 'Gemini TTS';
    this.logger.info(`Generating audio narration with ${engineName}...`);

    if (!engine) {
      this.logger.warn(`${engineName} not available, simulating audio`);
      return await this.simulateAudioGeneration(productionData);
    }

    try {
      const audioPathBase = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.wav`);
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');

      const audioPath = await engine.generate(ttsText, audioPathBase);

      productionData.assets.audio = {
        path: audioPath,
        duration: productionData.estimatedDuration,
        format: 'mp3',
        generatedWith: engineName,
        quality: 'high'
      };
      productionData.timeline.audioGenerated = new Date().toISOString();
      return audioPath;
    } catch (error) {
      // Extract the real error — Axios errors hide details in error.response.data
      const status  = error.response?.status;
      const apiMsg  = error.response?.data?.error?.message || error.response?.data?.message || '';
      const fullMsg = apiMsg || error.message || JSON.stringify(error.response?.data || '');
      this.logger.error(`${engineName} failed [${status || 'no-status'}]: ${fullMsg}`);

      // If rate limited, throw so the retry wrapper in daily-automation can back off and retry
      if (status === 429 || fullMsg.includes('429')) {
        throw new Error(`TTS rate limited (429) — will retry: ${fullMsg}`);
      }
      // For other errors (network blip etc), fall back to simulation
      return await this.simulateAudioGeneration(productionData);
    }
  }

  async simulateTTSGeneration(scriptPath, outputPath, config) {
    // This is a simulation - in production, you'd integrate with actual TTS services
    this.logger.info(`Simulating TTS generation: ${config.voice}`);
    
    // Create a placeholder audio file reference
    await fs.writeFile(outputPath + '.info', JSON.stringify({
      message: 'TTS audio would be generated here',
      config,
      timestamp: new Date().toISOString()
    }, null, 2));
  }

  async generateCaptions(productionData) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    
    // Generate SRT captions based on script timing
    const captions = await this.createSRTCaptions(productionData);
    
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });
    await fs.writeFile(captionsPath, captions);
    
    productionData.assets.captions = {
      path: captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();
    
    return captionsPath;
  }

  async createSRTCaptions(productionData) {
    const { script } = productionData;
    let srt = '';
    let captionIndex = 1;
    let currentTime = 0;
    
    // Helper function to format time for SRT
    const formatSRTTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };
    
    // Process script sections for captions
    const processText = (text, startTime, duration) => {
      const words = text.split(' ');
      const wordsPerCaption = 8; // Optimal words per caption
      
      for (let i = 0; i < words.length; i += wordsPerCaption) {
        const captionWords = words.slice(i, i + wordsPerCaption);
        const captionDuration = (duration / Math.ceil(words.length / wordsPerCaption));
        const captionStartTime = startTime + (i / words.length) * duration;
        const captionEndTime = captionStartTime + captionDuration;
        
        srt += `${captionIndex}\n`;
        srt += `${formatSRTTime(captionStartTime)} --> ${formatSRTTime(captionEndTime)}\n`;
        srt += `${captionWords.join(' ')}\n\n`;
        
        captionIndex++;
      }
    };
    
    // Hook
    if (script.hook && script.hook.text) {
      processText(script.hook.text, currentTime, 5);
      currentTime += 5;
    }
    
    // Introduction
    if (script.introduction) {
      const introText = `${script.introduction.greeting} ${script.introduction.topicIntro} ${script.introduction.valueProposition}`;
      processText(introText, currentTime, 15);
      currentTime += 15;
    }
    
    // Main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        let sectionText = '';
        
        if (Array.isArray(section.content)) {
          sectionText = section.content.filter(line => 
            typeof line === 'string' && !line.startsWith('[')
          ).join(' ');
        } else if (section.steps) {
          sectionText = section.steps.map(step => 
            `${step.title}. ${step.description}`
          ).join(' ');
        } else if (section.items) {
          sectionText = section.items.map(item => 
            `Number ${item.number}: ${item.title}. ${item.description}`
          ).join(' ');
        } else if (typeof section.content === 'string') {
          sectionText = section.content;
        }
        
        if (sectionText) {
          processText(sectionText, currentTime, section.duration || 60);
          currentTime += section.duration || 60;
        }
      });
    }
    
    // Conclusion
    if (script.conclusion) {
      const conclusionText = (Array.isArray(script.conclusion.recap) ? script.conclusion.recap.join(' ') : '') + ' ' + (script.conclusion.finalThought || '');
      processText(conclusionText, currentTime, 30);
      currentTime += 30;
    }
    
    return srt;
  }

  // Whether to show the Reddit-style intro card. Driven by config/topics.json
  // ("introCard": false disables it). Defaults to true so the legacy Reddit
  // theme is unchanged when no football config is present.
  introCardEnabled() {
    try {
      const fsSync = require('fs');
      const p = path.join(__dirname, '..', 'config', 'topics.json');
      if (fsSync.existsSync(p)) {
        const cfg = JSON.parse(fsSync.readFileSync(p, 'utf8'));
        if (cfg.introCard === false) return false;
      }
    } catch (_) {}
    return true;
  }

  // Generate safe, atmospheric Pexels search terms from the script.
  // Uses a safety-focused prompt so terms never name ethnic groups,
  // nationalities, or marginalised communities as visual subjects —
  // which would cause Pexels to return inappropriate modern lifestyle footage
  // for scripts about historical atrocities or persecution.
  async generateSafeVideoTerms(scriptText, subject) {
    if (!this.gemini) return null;
    try {
      const prompt = `You are selecting Pexels stock footage search terms for a short educational video.

Script topic: "${subject}"

Your job is to produce 5 search terms that capture the ATMOSPHERE, SETTING, and OBJECTS of this story — so a video editor can find relevant B-roll.

STRICT RULES:
- Focus on: locations, weather, architecture, objects, natural environments, lighting, time of day
- NEVER include the name of any ethnic group, nationality, religion, gender identity, or marginalised community as a visual subject — even if they appear in the script
- NEVER include terms like "African people", "Jewish people", "Japanese", "indigenous", "Black", "Asian", "Latino", "gay", "slave", "prisoner", or any other identity label
- Instead use the physical SETTING or OBJECT: "wooden ship hull", "ocean storm", "stone ruins", "candlelit document"
- Terms must return visually interesting footage, not portraits or modern lifestyle clips

Respond with ONLY a JSON array of 5 strings. No explanation.

Example for a script about Chernobyl:
["abandoned industrial building", "nuclear cooling tower", "dark dramatic sky", "concrete ruins overgrown", "warning sign weathered"]`;

      const result = await this.gemini.generateContent(prompt);
      const raw = result.response.text().trim().replace(/```json|```/g, '').trim();
      const terms = JSON.parse(raw);
      if (Array.isArray(terms) && terms.length) {
        this.logger.info(`Safe video terms: ${terms.join(', ')}`);
        return terms.join(',');
      }
    } catch (e) {
      this.logger.warn(`Safe term generation failed (${e.message}) — MPT will generate its own`);
    }
    return null;
  }

  // Run MoneyPrinterTurbo with --no-subtitle-enabled to get relevant Pexels
  // footage assembled into a clean video. Returns path to combined-1.mp4.
  // format 'short' → 9:16 portrait (Shorts), 'long' → 16:9 landscape (long-form).
  async runMPTForFootage(scriptText, subject, prodId, format = 'short') {
    const { spawn } = require('child_process');
    // MPT lives next to Youtube_Automation on the Desktop, not inside it
    const mptDir   = path.resolve(__dirname, '..', '..', '..', 'MoneyPrinterTurbo');
    const python   = path.join(mptDir, '.venv', 'bin', 'python3');
    const cli      = path.join(mptDir, 'cli.py');
    const taskId   = `vidshock_${prodId}`;
    const aspect   = format === 'long' ? '16:9' : '9:16';

    const safeTerms = await this.generateSafeVideoTerms(scriptText, subject);

    const args = [
      cli,
      '--video-subject', subject,
      '--video-script',  scriptText,
      '--video-source',  'pexels',
      '--video-aspect',  aspect,
      '--voice-name',    'en-US-AriaNeural',
      '--bgm-type',      'none',
      '--no-subtitle-enabled',
      '--task-id',       taskId
    ];
    if (safeTerms) args.push('--video-terms', safeTerms);

    // Hard timeout so a hung MPT process can't stall the pipeline forever.
    // Measured across 3 live long-form runs: MPT takes roughly 3-7x the final
    // video's runtime to source and stitch clips (154s video → ~8min MPT,
    // 446s video → ~38min MPT). At the ~16-19min target this scales to
    // 80-130min in the worst case, so this gets a large allowance. Every run
    // must still terminate eventually rather than hang indefinitely.
    const timeoutMs = format === 'long' ? 150 * 60 * 1000 : 6 * 60 * 1000;

    this.logger.info(`Running MPT for footage (task: ${taskId}, timeout: ${Math.round(timeoutMs / 60000)}min)…`);
    await new Promise((resolve, reject) => {
      const proc = spawn(python, args, { cwd: mptDir, env: { ...process.env } });
      let stderr = '';
      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        this.logger.warn(`MPT exceeded ${Math.round(timeoutMs / 60000)}min — killing process`);
        proc.kill('SIGKILL');
      }, timeoutMs);

      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.stdout.on('data', () => {});
      proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
      proc.on('close', code => {
        clearTimeout(killTimer);
        if (timedOut) return reject(new Error(`MPT timed out after ${Math.round(timeoutMs / 60000)} minutes`));
        if (code === 0) resolve();
        else reject(new Error(`MPT exited ${code}: ${stderr.slice(-400)}`));
      });
    });

    const combinedPath = path.join(mptDir, 'storage', 'tasks', taskId, 'combined-1.mp4');
    await fs.access(combinedPath);
    return combinedPath;
  }

  // Long-form per-beat footage: fetch one Pexels clip per chapter (using the
  // chapter's footageQuery) and weight each clip's on-screen duration to that
  // chapter's share of the narration word count. Returns a 'segments' bgResult
  // for VideoAssembler, or null if too few clips could be sourced (caller then
  // falls back to the whole-script MPT reel).
  async fetchPerChapterFootage(chapters, audioDuration, prodId, videoAssembler) {
    const usable = (chapters || []).filter(c => (c.footageQuery || '').trim());
    if (usable.length < 2) return null;

    const workDir = path.join(__dirname, '..', 'data', 'assets', `${prodId}_clips`);
    await fs.mkdir(workDir, { recursive: true });

    // Weight each chapter's duration by its narration word count (equal split
    // if word counts are missing), so visuals change roughly in step with the
    // story rather than on a fixed timer.
    const weights = usable.map(c => Math.max(1, c.wordCount || 1));
    const totalW = weights.reduce((a, b) => a + b, 0);

    const clips = [];
    for (let i = 0; i < usable.length; i++) {
      const query = usable[i].footageQuery.trim();
      const clipPath = path.join(workDir, `clip${i}.mp4`);
      const segDuration = audioDuration * (weights[i] / totalW);
      this.logger.info(`Chapter ${i + 1}/${usable.length} footage — "${query}" (${segDuration.toFixed(1)}s)`);
      const ok = await videoAssembler.fetchPexelsVideoByQuery(query, clipPath);
      if (ok) {
        clips.push({ path: clipPath, duration: segDuration });
      } else {
        this.logger.warn(`No Pexels footage for "${query}" — reweighting remaining chapters`);
      }
    }

    // Need most chapters covered for the per-beat look to hold up. If Pexels
    // returned too few, bail so the caller uses the MPT reel instead.
    if (clips.length < Math.ceil(usable.length * 0.6)) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    // Some queries may have failed — rescale the surviving clips so their
    // durations still sum to the full narration length (no black tail).
    const sumDur = clips.reduce((a, c) => a + c.duration, 0);
    const scale = audioDuration / sumDur;
    for (const c of clips) c.duration *= scale;

    return { type: 'segments', clips, workDir };
  }

  async assembleVideo(productionData) {
    this.logger.info('Assembling video with ffmpeg...');

    // Skip if audio is simulated (no real audio file)
    if (productionData.assets.audio?.simulated) {
      this.logger.warn('Audio is simulated — skipping real video assembly');
      return await this.simulateVideoAssembly(productionData);
    }

    try {
      const format = productionData.strategy?.format || 'short';
      const videoAssembler   = this.videoAssemblers[format]   || this.videoAssemblers.short;
      const captionRenderer  = this.captionRenderers[format]  || this.captionRenderers.short;

      const title = productionData.script?.title || 'Untitled';
      const topic = productionData.strategy?.topic || title;
      const bgBasePath = path.join(__dirname, '..', 'data', 'assets', `${productionData.id}_bg.jpg`);
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);

      // 1. Prepare background. Long-form: per-chapter Pexels clips cut to
      //    narration beats (each chapter's footageQuery). Falls back to the
      //    whole-script MPT reel, then local clips. Shorts: MPT reel as before.
      let bgResult;
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8').catch(() => '');
      const chapters = productionData.script?.chapters;

      if (format === 'long' && Array.isArray(chapters) && chapters.some(c => c.footageQuery)) {
        try {
          this._statusCallback('🎬 Finding footage for each chapter…');
          const audioDur = await videoAssembler.getAudioDuration(productionData.assets.audio.path);
          bgResult = await this.fetchPerChapterFootage(chapters, audioDur, productionData.id, videoAssembler);
          if (bgResult) this.logger.info(`Per-chapter footage: ${bgResult.clips.length} clips`);
        } catch (e) {
          this.logger.warn(`Per-chapter footage failed (${e.message})`);
        }
      }

      if (!bgResult && ttsText) {
        try {
          this._statusCallback('🎬 Finding footage on Pexels…');
          const footagePath = await this.runMPTForFootage(ttsText, title, productionData.id, format);
          // Tag the MPT task folder explicitly (rather than deriving it from
          // gameplayPath's dirname) so cleanup never risks touching the local
          // gameplay clip fallback path, which lives under data/assets/.
          bgResult = { type: 'brainrot', gameplayPath: footagePath, mptTaskDir: path.dirname(footagePath) };
        } catch (e) {
          this.logger.warn(`MPT footage failed (${e.message}) — falling back to local clips`);
          bgResult = await videoAssembler.createBackground(topic, title, bgBasePath);
        }
      } else if (!bgResult) {
        bgResult = await videoAssembler.createBackground(topic, title, bgBasePath);
      }
      this.logger.info(`Background ready (${bgResult.type})`);

      // 1b. Build Phase 2 overlays — captions, reddit card, music bed.
      // All optional: if any step fails the video still assembles without it.
      const audioPath = productionData.assets.audio.path;
      const capWorkDir = path.join(__dirname, '..', 'data', 'assets', `${productionData.id}_cap`);
      const extras = {};

      // Captions (whisper → transparent caption track)
      try {
        const dur = await videoAssembler.getAudioDuration(audioPath);
        const cap = await captionRenderer.generate(audioPath, capWorkDir, productionData.id, dur);
        if (cap) extras.captionTrack = cap.trackPath;
      } catch (e) { this.logger.warn(`Captions skipped: ${e.message}`); }

      // Reddit intro card (from the script's cardText).
      // Disabled when config/topics.json sets "introCard": false (e.g. football
      // content), and always skipped for long-form documentary-style videos —
      // the Reddit-drama banner doesn't fit a true-crime/history format.
      try {
        const cardText = productionData.script?.cardText;
        if (cardText && format !== 'long' && this.introCardEnabled()) {
          const cardPath = path.join(__dirname, '..', 'data', 'assets', `${productionData.id}_card.png`);
          await this.redditCard.render(cardText, this.channelName, cardPath);
          extras.cardPath = cardPath;
          extras.cardDuration = 5;
        } else if (cardText && format !== 'long') {
          this.logger.info('Intro card disabled (introCard:false) — skipping Reddit banner.');
        }
      } catch (e) { this.logger.warn(`Reddit card skipped: ${e.message}`); }

      // Background music bed (any .mp3 in data/music/, picked at random)
      try {
        const musicDir = path.join(__dirname, '..', 'data', 'music');
        const tracks = (await fs.readdir(musicDir).catch(() => []))
          .filter(f => /\.(mp3|m4a|wav|aac)$/i.test(f));
        if (tracks.length) {
          extras.musicPath = path.join(musicDir, tracks[Math.floor(Math.random() * tracks.length)]);
          this.logger.info(`Background music: ${path.basename(extras.musicPath)}`);
        }
      } catch (_) {}

      // 2. Assemble final video with all overlays
      this._statusCallback('✂️ Assembling final video…');
      const result = await videoAssembler.assemble(
        bgResult,
        audioPath,
        finalVideoPath,
        extras
      );

      // Clean up caption working files
      await fs.rm(capWorkDir, { recursive: true, force: true }).catch(() => {});

      productionData.assets.finalVideo = {
        path: finalVideoPath,
        fileSize: result.size,
        duration: `${Math.round(result.duration / 60)}:${String(Math.round(result.duration % 60)).padStart(2, '0')}`,
        resolution: format === 'long' ? '1920x1080' : '1080x1920',
        format: 'mp4'
      };
      productionData.timeline.videoGenerated = new Date().toISOString();
      this.logger.info(`Video assembled: ${(result.size / 1024 / 1024).toFixed(1)} MB`);

      // Generate custom thumbnail — gameplay frame + Hindi title text overlay.
      // The video itself stays pure gameplay; this is a separate 1280×720 image
      // uploaded to YouTube via thumbnails.set() right after the video upload.
      const thumbnailPath = path.join(__dirname, '..', 'data', 'assets', `${productionData.id}_thumb.jpg`);
      const gameplaySource = bgResult.gameplayPath || finalVideoPath;
      const thumbResult = await videoAssembler.generateThumbnail(
        gameplaySource,
        title,
        thumbnailPath
      );
      if (thumbResult) {
        productionData.assets.thumbnail = {
          path: thumbResult,
          dimensions: { width: 1280, height: 720 },
          format: 'jpg'
        };
        this.logger.info('Custom thumbnail ready');
      }

      // Clean up intermediate source files now that ffmpeg has fully consumed
      // them into finalVideoPath and the thumbnail has been extracted. These
      // are pure waste from this point — raw audio, source clips, and (the
      // biggest offender) MPT's downloaded Pexels footage under
      // MoneyPrinterTurbo/storage/tasks/, which never got cleaned up before
      // and was outgrowing the published videos themselves.
      await this.cleanupIntermediateSources(bgResult, audioPath);

      return finalVideoPath;
    } catch (error) {
      this.logger.error('Video assembly failed:', error.message);
      return await this.simulateVideoAssembly(productionData);
    }
  }

  // Delete every per-production input once it has been fully consumed by
  // ffmpeg (and, for gameplay footage, by the thumbnail extractor). Never
  // throws — a failed cleanup should never fail a production that already
  // succeeded. Each branch only removes files this exact production created,
  // never a shared directory, so it can't touch another production's assets
  // or the static local-gameplay/music library.
  async cleanupIntermediateSources(bgResult, audioPath) {
    const rm = async (p) => { try { await fs.rm(p, { recursive: true, force: true }); } catch (_) {} };

    try {
      if (bgResult.type === 'brainrot' && bgResult.mptTaskDir) {
        // MPT's downloaded Pexels source clips — this is the big one. A single
        // long-form task folder was measured at ~90MB+ and none were ever
        // being cleaned up automatically.
        let sizeMB = 0;
        try {
          const { stdout } = await require('util').promisify(require('child_process').exec)(
            `du -sm "${bgResult.mptTaskDir}" 2>/dev/null | cut -f1`
          );
          sizeMB = parseInt(stdout.trim(), 10) || 0;
        } catch (_) {}
        await rm(bgResult.mptTaskDir);
        this.logger.info(`Cleaned up MPT source footage (~${sizeMB}MB): ${path.basename(bgResult.mptTaskDir)}`);
      } else if (bgResult.type === 'brainrot' && bgResult.gameplayPath) {
        // Local gameplay clip fallback — a per-production extracted copy, not
        // the shared library file, so safe to delete.
        await rm(bgResult.gameplayPath);
      } else if (bgResult.type === 'segments') {
        // Per-chapter Pexels clips live under data/assets/<id>_clips — remove
        // the whole working dir once the final video is assembled.
        if (bgResult.workDir) await rm(bgResult.workDir);
      } else if (bgResult.type === 'video') {
        for (const p of bgResult.bgPaths || []) await rm(p);
        if (bgResult.overlayPath) await rm(bgResult.overlayPath);
      } else if (bgResult.type === 'image') {
        if (bgResult.bgPath) await rm(bgResult.bgPath);
        if (bgResult.overlayPath) await rm(bgResult.overlayPath);
      } else if (bgResult.type === 'gradient' && bgResult.bgPath) {
        await rm(bgResult.bgPath);
      }
    } catch (e) {
      this.logger.warn(`Background source cleanup skipped: ${e.message}`);
    }

    // Raw narration audio — already fully muxed into the final video.
    if (audioPath) await rm(audioPath);
  }

  async simulateVideoRendering(instructions) {
    this.logger.info('Simulating video rendering...');
    
    // Create a placeholder that indicates video would be rendered
    await fs.writeFile(instructions.outputPath + '.placeholder', JSON.stringify({
      message: 'Final video would be rendered here',
      instructions,
      timestamp: new Date().toISOString()
    }, null, 2));
  }

  async getPipelineStatus() {
    return this.pipeline.map(item => ({
      id: item.id,
      title: item.script?.title || 'Untitled',
      status: item.status,
      priority: item.priority,
      scheduledPublishTime: item.scheduledPublishTime,
      progress: this.calculateProgress(item)
    }));
  }

  calculateProgress(productionData) {
    const milestones = [
      'scriptReady',
      'thumbnailReady',
      'audioGenerated',
      'videoGenerated',
      'captionsGenerated',
      'readyForUpload'
    ];
    
    const completed = milestones.filter(milestone => 
      productionData.timeline[milestone] !== null
    ).length;
    
    return Math.round((completed / milestones.length) * 100);
  }

  async getNextReadyContent() {
    const ready = this.pipeline
      .filter(item => item.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
    
    return ready[0] || null;
  }

  // Helper method to create visual prompts from script content
  createVisualPromptsFromScript(script) {
    const prompts = [];
    
    // Title prompt
    prompts.push(`${script.title}, ethereal storytelling, mystical background`);
    
    // Content-based prompts
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (section.title) {
          prompts.push(`${section.title}, ethereal dreamscape, creative visualization`);
        }
      });
    }
    
    // Ensure we have at least 3 prompts
    while (prompts.length < 3) {
      prompts.push('ethereal dreamscape, mystical storytelling, creative visualization');
    }
    
    return prompts.slice(0, 5); // Limit to 5 for cost control
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
      duration: productionData.estimatedDuration,
      format: 'mp3',
      simulated: true
    };
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };