const express = require('express');
const path = require('path');
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold('\n🎬 YouTube Automation Agent v1.0'));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        return false;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db);
      await this.scheduler.initialize();
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  setupAPI() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'dashboard')));
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        initialized: this.isInitialized,
        agents: Object.keys(this.agents),
        timestamp: new Date().toISOString()
      });
    });

    // Dashboard branding — channel name pulled from config (falls back to generic)
    this.app.get('/config', (req, res) => {
      const channelName = this.credentials?.credentials?.channel?.channelName || 'YouTube Automation';
      res.json({ channelName });
    });

    // Generation status — polled by dashboard every 2s during active generation
    this.generationStatus = { active: false, step: '' };
    this.app.get('/status', (req, res) => {
      res.json(this.generationStatus);
    });

    // Manual content generation — format: 'short' (default, Shorts) or 'long' (long-form)
    this.app.post('/generate', async (req, res) => {
      try {
        const { topic, style, length, format } = req.body;
        const result = await this.generateContent(topic, style, length, format === 'long' ? 'long' : 'short');
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // List generated scripts
    this.app.get('/content', async (req, res) => {
      try {
        const rows = await this.db.getAllRows('SELECT id, title, duration, tone, created_at FROM scripts ORDER BY created_at DESC LIMIT 20');
        res.json({ success: true, scripts: rows });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // View a single script's full content
    this.app.get('/content/:id', async (req, res) => {
      try {
        const row = await this.db.getRow('SELECT * FROM scripts WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Script not found' });
        row.hook = JSON.parse(row.hook || '{}');
        row.introduction = JSON.parse(row.introduction || '{}');
        row.mainContent = JSON.parse(row.main_content || '{}');
        row.conclusion = JSON.parse(row.conclusion || '{}');
        row.callToAction = JSON.parse(row.call_to_action || '{}');
        row.keywords = JSON.parse(row.keywords || '[]');
        res.json({ success: true, script: row });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        const analytics = await this.agents.analytics.getRecentAnalytics();
        res.json(analytics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Per-angle performance (real YouTube view counts) — which niches/angles
    // are actually winning, and the weight multiplier the topic picker is
    // currently applying to each. ?format=short|long, defaults to short.
    this.app.get('/analytics/angle-performance', async (req, res) => {
      try {
        const format = req.query.format === 'long' ? 'long' : 'short';
        const report = await this.agents.strategy.getAnglePerformanceReport(format);
        res.json({ format, angles: report });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Recent failures for the dashboard — from automation_events (status=error)
    this.app.get('/failures', async (req, res) => {
      try {
        const rows = await this.db.getAllRows(
          "SELECT event_type, data, created_at FROM automation_events WHERE status = 'error' ORDER BY created_at DESC LIMIT 25"
        ).catch(() => []);
        const items = rows.map(r => {
          let msg = '';
          try { msg = JSON.parse(r.data || '{}').error || ''; } catch (_) { msg = r.data || ''; }
          // created_at is stored UTC — present in AEST/AEDT, DD/MM/YYYY HH:MM
          let when = r.created_at;
          try {
            const d = new Date((r.created_at || '').replace(' ', 'T') + 'Z');
            when = d.toLocaleString('en-AU', {
              timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit',
              year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
            });
          } catch (_) {}
          return { stage: r.event_type, error: msg, when, raw: r.created_at };
        });
        res.json({ count: items.length, items });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // All videos (published + scheduled) for dashboard
    this.app.get('/videos', async (req, res) => {
      try {
        const rows = await this.db.getAllRows(
          `SELECT id, production_id, title, publish_time, status, youtube_id, youtube_url, published_at, created_at
           FROM publish_schedule ORDER BY created_at DESC`
        );
        res.json(rows);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Dashboard stats summary
    this.app.get('/stats', async (req, res) => {
      try {
        // Dedupe by youtube_id (falling back to id for rows without one) —
        // guards against any row that ends up double-tracked, e.g. by /sync-youtube.
        const [published, scheduled, scripts] = await Promise.all([
          this.db.getRow(`SELECT COUNT(DISTINCT COALESCE(youtube_id, id)) as count FROM publish_schedule WHERE status = 'published'`),
          this.db.getRow(`SELECT COUNT(DISTINCT COALESCE(youtube_id, id)) as count FROM publish_schedule WHERE status = 'scheduled'`),
          this.db.getRow(`SELECT COUNT(*) as count FROM scripts`)
        ]);
        res.json({
          published: published?.count || 0,
          scheduled: scheduled?.count || 0,
          scriptsGenerated: scripts?.count || 0
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Total view count across all published videos — fetched live from YouTube API
    this.app.get('/stats/views', async (req, res) => {
      try {
        const rows = await this.db.getAllRows(
          `SELECT DISTINCT youtube_id FROM publish_schedule WHERE status = 'published' AND youtube_id IS NOT NULL`
        );
        if (!rows.length) return res.json({ totalViews: 0, videoCount: 0 });

        const youtube = this.credentials.getYouTubeClient();
        const BATCH   = 50;
        let totalViews = 0;
        let videoCount = 0;

        for (let i = 0; i < rows.length; i += BATCH) {
          const ids = rows.slice(i, i + BATCH).map(r => r.youtube_id).join(',');
          const response = await youtube.videos.list({ part: 'statistics', id: ids });
          for (const item of response.data.items || []) {
            totalViews += parseInt(item.statistics?.viewCount || 0);
            videoCount++;
          }
        }

        res.json({ totalViews, videoCount });
      } catch (error) {
        res.status(500).json({ error: error.message, totalViews: 0 });
      }
    });

    // Sync published videos from YouTube channel into local DB
    this.app.post('/sync-youtube', async (req, res) => {
      try {
        const youtube = this.credentials.getYouTubeClient();

        // 1. Get the authenticated user's channel + uploads playlist ID
        const meRes = await youtube.channels.list({ part: 'contentDetails', mine: true });
        const uploadsId = meRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsId) return res.status(400).json({ error: 'Could not find uploads playlist' });

        // 2. Walk all pages of the uploads playlist
        const videoIds = [];
        let pageToken = undefined;
        do {
          const plRes = await youtube.playlistItems.list({
            part: 'contentDetails', playlistId: uploadsId,
            maxResults: 50, pageToken
          });
          for (const item of plRes.data.items || []) {
            const vid = item.contentDetails?.videoId;
            if (vid) videoIds.push(vid);
          }
          pageToken = plRes.data.nextPageToken;
        } while (pageToken);

        if (!videoIds.length) return res.json({ synced: 0 });

        // 3. Fetch title + publish time + statistics in batches of 50
        const BATCH = 50;
        let synced = 0;
        for (let i = 0; i < videoIds.length; i += BATCH) {
          const ids = videoIds.slice(i, i + BATCH).join(',');
          const vidRes = await youtube.videos.list({
            part: 'snippet,statistics', id: ids
          });
          for (const item of vidRes.data.items || []) {
            const ytId  = item.id;
            const title = item.snippet?.title || 'Untitled';
            const pubAt = item.snippet?.publishedAt || new Date().toISOString();
            const ytUrl = `https://www.youtube.com/watch?v=${ytId}`;

            // The pipeline already creates a row for every video it publishes
            // itself — update THAT row instead of inserting a new synthetic
            // one, or every synced video ends up double-counted in /stats.
            const existing = await this.db.getRow(
              `SELECT id FROM publish_schedule WHERE youtube_id = ? LIMIT 1`, [ytId]
            );
            if (existing) {
              await this.db.executeQuery(
                `UPDATE publish_schedule SET title = ?, status = 'published', youtube_url = ?, published_at = ? WHERE id = ?`,
                [title, ytUrl, pubAt, existing.id]
              );
            } else {
              // Not tracked by the pipeline at all (e.g. uploaded before this
              // tool existed) — only then does it get a synthetic row.
              const entryId = `yt_sync_${ytId}`;
              const prodId  = `yt_sync_prod_${ytId}`;
              await this.db.executeQuery(
                `INSERT OR REPLACE INTO publish_schedule
                   (id, production_id, title, publish_time, status, youtube_id, youtube_url, published_at, created_at)
                 VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
                [entryId, prodId, title, pubAt, ytId, ytUrl, pubAt, pubAt]
              );
            }
            synced++;
          }
        }

        res.json({ synced });
      } catch (error) {
        this.logger.error('YouTube sync failed:', error.message);
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', async (req, res) => {
      try {
        const { contentId } = req.params;
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // List long-form videos staged for review (in data/review/)
    this.app.get('/review', async (req, res) => {
      try {
        const fsp = require('fs').promises;
        const reviewDir = path.join(__dirname, 'data', 'review');
        const files = await fsp.readdir(reviewDir).catch(() => []);
        const items = [];
        for (const f of files.filter(f => f.endsWith('.json'))) {
          const e = JSON.parse(await fsp.readFile(path.join(reviewDir, f), 'utf8'));
          items.push({
            id: e.productionId,
            title: e.title,
            video: f.replace('.json', '.mp4'),
            stagedAt: e.createdAt
          });
        }
        res.json({ count: items.length, items });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Approve + upload a reviewed long-form video
    this.app.post('/review/:contentId/approve', async (req, res) => {
      try {
        const result = await this.publishReviewed(req.params.contentId);
        res.json({ success: true, youtubeUrl: result.youtubeUrl });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  setStatus(step) {
    if (this.generationStatus) this.generationStatus = { active: true, step };
  }

  async generateContent(topic = null, style = null, length = 'medium', format = 'short') {
    this.generationStatus = { active: true, step: 'Starting up…' };
    this.logger.info(`Starting content generation pipeline (format: ${format})...`);

    try {
      // Step 1: Strategy
      this.setStatus(format === 'long' ? '🔍 Finding a long-form topic…' : '🔍 Finding a Reddit story…');
      const strategy = await this.agents.strategy.generateContentStrategy(topic, format);
      this.logger.info(`Strategy generated: ${strategy.topic}`);

      // Step 2: Script Writing
      this.setStatus('✍️ Writing the script…');
      const script = await this.agents.scriptWriter.generateScript(strategy);
      this.logger.info(`Script generated: ${script.title}`);

      // Step 3: Thumbnail Design
      this.setStatus('🎨 Generating AI thumbnail…');
      const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
      this.logger.info('Thumbnail generated');

      // Step 4: SEO Optimization
      this.setStatus('🏷️ Optimising tags & description…');
      const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
      this.logger.info('SEO optimization complete');

      // Step 5: Production Management (TTS + video assembly)
      this.setStatus('🎙️ Generating voiceover with Aoede…');
      const productionData = await this.agents.production.processContent(
        { strategy, script, thumbnail, seo: seoData },
        (step) => this.setStatus(step)
      );
      this.logger.info('Production processing complete');

      // Step 6: Save to database
      this.setStatus('💾 Saving to database…');
      const contentId = await this.db.saveProductionData(productionData);
      this.logger.info(`Content saved with ID: ${contentId}`);

      // Long-form review gate: copy the finished video into data/review/ and
      // STOP — a human watches it and runs the publish step manually. Nothing
      // long-form reaches YouTube unseen. Shorts continue to auto-publish below.
      if (format === 'long') {
        const reviewInfo = await this.stageForReview(productionData, script);
        this.generationStatus = { active: false, step: '' };
        this.logger.success(`Long-form staged for review: ${reviewInfo.reviewPath}`);
        return {
          contentId,
          title: script.title,
          review: true,
          reviewPath: reviewInfo.reviewPath,
          message: 'Long-form video staged for review — not uploaded. Approve to publish.'
        };
      }

      // Step 7: Schedule for publishing
      const scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
      this.logger.info(`Content scheduled: ${scheduleEntry.publishTime}`);

      // Step 8: Upload to YouTube
      this.setStatus('🚀 Uploading to YouTube…');
      try {
        const published = await this.agents.publishing.publishContent(productionData.id);
        this.logger.info(`Uploaded to YouTube: ${published.youtubeUrl}`);
        this.generationStatus = { active: false, step: '' };
        return {
          contentId,
          title: script.title,
          scheduledFor: productionData.scheduledPublishTime,
          youtubeUrl: published.youtubeUrl
        };
      } catch (uploadError) {
        this.logger.error(`YouTube upload failed: ${uploadError.message}`);
        this.generationStatus = { active: false, step: '' };
        return {
          contentId,
          title: script.title,
          scheduledFor: productionData.scheduledPublishTime,
          uploadError: uploadError.message
        };
      }
    } catch (err) {
      this.generationStatus = { active: false, step: '' };
      // Record manual-run failures too, so the dashboard's failures panel
      // captures every failure (the daily cron already logs its own).
      try {
        await this.db.executeQuery(
          'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
          [`manual_generation_${format}`, 'error', JSON.stringify({ error: err.message })]
        );
      } catch (_) { /* logging must never mask the original error */ }
      throw err;
    }
  }

  // Move a finished long-form video into data/review/ and write a complete
  // schedule-entry sidecar (title, SEO, thumbnail, captions, video path all
  // pointed at the review copy). Nothing is queued, so the auto-publish cron
  // can never grab it — only an explicit publishReviewed() call uploads it.
  // Moving (not copying) avoids a duplicate ~400MB file on disk.
  async stageForReview(productionData, script) {
    const fs = require('fs').promises;
    const reviewDir = path.join(__dirname, 'data', 'review');
    await fs.mkdir(reviewDir, { recursive: true });

    const safeTitle = (script.title || 'untitled')
      .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60).toLowerCase();
    const base = `${productionData.id}_${safeTitle}`;
    const reviewPath = path.join(reviewDir, `${base}.mp4`);

    const finalPath = productionData.assets?.finalVideo?.path;
    if (!finalPath) throw new Error('No final video to stage for review');
    await fs.rename(finalPath, reviewPath);
    productionData.assets.finalVideo.path = reviewPath;

    // Thumbnail alongside, if one was produced
    const thumbAsset = productionData.assets?.thumbnail;
    if (thumbAsset?.path) {
      const reviewThumb = path.join(reviewDir, `${base}.jpg`);
      await fs.copyFile(thumbAsset.path, reviewThumb).catch(() => {});
    }

    // Full schedule-entry sidecar — publishReviewed replays this straight
    // through the normal upload path with no re-generation.
    const scheduleEntry = {
      productionId: productionData.id,
      id: productionData.id,
      title: script.title,
      publishTime: new Date().toISOString(),
      status: 'awaiting_review',
      priority: productionData.priority || 'normal',
      angle: productionData.strategy?.angle || null,
      format: 'long',
      metadata: {
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        captions: productionData.assets.captions
      },
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(path.join(reviewDir, `${base}.json`), JSON.stringify(scheduleEntry, null, 2));

    try {
      const { exec } = require('child_process');
      exec(`osascript -e 'display notification "${safeTitle}" with title "Vid Shock: long-form ready to review" sound name "Glass"'`, () => {});
    } catch (_) {}

    return { reviewPath };
  }

  // Publish a reviewed+approved long-form video. Pass the production/content id
  // (the filename prefix in data/review/). Reads the sidecar, pushes it into
  // the publish queue, and runs the standard upload+cleanup path.
  async publishReviewed(contentId) {
    const fs = require('fs').promises;
    const reviewDir = path.join(__dirname, 'data', 'review');
    const files = await fs.readdir(reviewDir);
    const sidecar = files.find(f => f.startsWith(contentId) && f.endsWith('.json'));
    if (!sidecar) throw new Error(`No staged review found for id: ${contentId}`);

    const entry = JSON.parse(await fs.readFile(path.join(reviewDir, sidecar), 'utf8'));
    this.logger.info(`Publishing reviewed long-form: ${entry.title}`);

    // Inject into the queue so the existing publishContent handles upload,
    // DB record, first comment, and cleanup uniformly.
    this.agents.publishing.publishQueue.push(entry);
    const published = await this.agents.publishing.publishContent(contentId);

    // Remove the sidecar (the video was cleaned up by publishContent already)
    await fs.rm(path.join(reviewDir, sidecar), { force: true }).catch(() => {});
    await fs.rm(path.join(reviewDir, sidecar.replace('.json', '.jpg')), { force: true }).catch(() => {});

    this.logger.success(`Uploaded reviewed video: ${published.youtubeUrl}`);
    return published;
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.yellow('\n🤖 Automation is active. Content will be generated and posted daily.'));
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };