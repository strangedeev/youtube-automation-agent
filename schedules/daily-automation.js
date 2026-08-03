const cron = require('node-cron');
const { Logger } = require('../utils/logger');

class DailyAutomation {
  constructor(agents, database) {
    this.agents = agents;
    this.db = database;
    this.logger = new Logger('DailyAutomation');
    this.scheduledTasks = new Map();
    this.isEnabled = true;
  }

  async initialize() {
    this.logger.info('Initializing daily automation scheduler...');
    
    await this.setupScheduledTasks();
    
    // Start monitoring loop
    this.startMonitoringLoop();
    
    this.logger.success('Daily automation initialized successfully');
    return true;
  }

  async setupScheduledTasks() {
    // One video per day at 12:00 PM — new channels benefit from giving
    // YouTube time to find the right audience between uploads rather than
    // flooding the algorithm before it has figured out who to show us to.
    this.scheduledTasks.set('daily-content-generation',
      cron.schedule('0 12 * * *', async () => {
        if (this.isEnabled) await this.runDailyContentGeneration();
      }, { scheduled: false })
    );

    // Publishing queue processing every 15 minutes
    this.scheduledTasks.set('publish-queue-processing',
      cron.schedule('*/15 * * * *', async () => {
        if (this.isEnabled) {
          await this.processPublishQueue();
        }
      }, { scheduled: false })
    );

    // Analytics collection at 9:00 AM daily
    this.scheduledTasks.set('daily-analytics',
      cron.schedule('0 9 * * *', async () => {
        if (this.isEnabled) {
          await this.collectDailyAnalytics();
        }
      }, { scheduled: false })
    );

    // Weekly performance sync — every Sunday at 8:00 AM
    this.scheduledTasks.set('weekly-performance-sync',
      cron.schedule('0 8 * * 0', async () => {
        if (this.isEnabled) {
          await this.syncVideoPerformance();
        }
      }, { scheduled: false })
    );

    // Weekly strategy review on Sundays at 8:00 AM
    this.scheduledTasks.set('weekly-strategy-review',
      cron.schedule('0 8 * * 0', async () => {
        if (this.isEnabled) {
          await this.weeklyStrategyReview();
        }
      }, { scheduled: false })
    );

    // Optimization tasks daily at 10:00 PM
    this.scheduledTasks.set('daily-optimization',
      cron.schedule('0 22 * * *', async () => {
        if (this.isEnabled) {
          await this.runDailyOptimization();
        }
      }, { scheduled: false })
    );

    // Database maintenance weekly on Saturdays at 3:00 AM
    this.scheduledTasks.set('database-maintenance',
      cron.schedule('0 3 * * 6', async () => {
        if (this.isEnabled) {
          await this.databaseMaintenance();
        }
      }, { scheduled: false })
    );

    // Start all scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      task.start();
      this.logger.info(`Started scheduled task: ${name}`);
    });
  }

  // Retry helper — waits 60s between attempts so transient API errors can clear
  async withRetry(fn, label, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        const delaySec = attempt * 60;
        this.logger.warn(`${label} failed (attempt ${attempt}/${maxAttempts}) — retrying in ${delaySec}s: ${error.message}`);
        await new Promise(r => setTimeout(r, delaySec * 1000));
      }
    }
  }

  async runDailyContentGeneration() {
    try {
      this.logger.info('Starting daily content generation...');

      const timer = this.logger.startTimer('Daily Content Generation');

      // Check if we should generate content today
      const shouldGenerate = await this.shouldGenerateContentToday();

      if (!shouldGenerate) {
        this.logger.info('Skipping content generation - sufficient content in pipeline');
        return;
      }

      // Generate content strategy (retry up to 3x — Gemini can occasionally time out)
      const strategy = await this.withRetry(
        () => this.agents.strategy.generateContentStrategy(),
        'Strategy generation'
      );
      this.logger.info(`Generated strategy: ${strategy.topic}`);

      // Generate script (retry up to 3x)
      const script = await this.withRetry(
        () => this.agents.scriptWriter.generateScript(strategy),
        'Script generation'
      );
      this.logger.info(`Generated script: ${script.title}`);

      // Generate thumbnail (retry up to 3x — a transient sharp/fs error must not kill the day)
      const thumbnail = await this.withRetry(
        () => this.agents.thumbnailDesigner.generateThumbnail(script),
        'Thumbnail generation'
      );
      this.logger.info('Generated thumbnail');

      // Optimize SEO (retry up to 3x)
      const seoData = await this.withRetry(
        () => this.agents.seoOptimizer.optimize(script, strategy),
        'SEO optimization'
      );
      this.logger.info('Completed SEO optimization');

      // Process through production (TTS + video — retry up to 3x)
      const productionData = await this.withRetry(
        () => this.agents.production.processContent({ strategy, script, thumbnail, seo: seoData }),
        'Production'
      );
      this.logger.info(`Production completed: ${productionData.id}`);

      // Schedule and immediately upload to YouTube (retry up to 3x)
      await this.agents.publishing.scheduleContent(productionData);
      this.logger.info('Content scheduled for publishing');

      const published = await this.withRetry(
        () => this.agents.publishing.publishContent(productionData.id),
        'YouTube upload'
      );
      this.logger.info(`Uploaded to YouTube: ${published.youtubeUrl}`);

      // Track the video for performance analytics
      if (published.youtubeId) {
        await this.db.savePublishedVideo({
          youtubeId: published.youtubeId,
          title: script.title,
          topic: strategy.topic
        });
      }

      timer.end();
      this.logger.success('Daily content generation completed successfully');

      await this.logAutomationEvent('daily_content_generation', 'success', {
        contentId: productionData.id,
        topic: strategy.topic,
        youtubeUrl: published.youtubeUrl
      });

    } catch (error) {
      this.logger.error('Daily content generation failed after all retries:', error);

      await this.logAutomationEvent('daily_content_generation', 'error', {
        error: error.message
      });

      await this.sendFailureNotification('Daily Content Generation', error);
    }
  }

  async shouldGenerateContentToday() {
    // Check content buffer
    const upcomingContent = await this.agents.publishing.getUpcomingSchedule(3);
    const bufferDays = parseInt(await this.db.getSetting('content_buffer_days')) || 3;
    
    // Check if we have enough content scheduled
    if (upcomingContent.length >= bufferDays) {
      return false;
    }

    // Check posting frequency settings
    const frequency = await this.db.getSetting('posting_frequency') || 'daily';
    const lastGeneration = await this.db.getSetting('last_content_generation');
    
    if (lastGeneration) {
      const lastDate = new Date(lastGeneration);
      const today = new Date();
      const daysSinceLastGeneration = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));
      
      switch (frequency) {
        case 'daily':
          return daysSinceLastGeneration >= 1;
        case 'every-2-days':
          return daysSinceLastGeneration >= 2;
        case '3-per-week':
          return daysSinceLastGeneration >= 2 || [1, 3, 5].includes(today.getDay());
        case 'weekly':
          return daysSinceLastGeneration >= 7;
        default:
          return true;
      }
    }

    return true;
  }

  async processPublishQueue() {
    try {
      const published = await this.agents.publishing.processPublishQueue();
      
      if (published > 0) {
        this.logger.info(`Published ${published} videos from queue`);
        
        await this.logAutomationEvent('queue_processing', 'success', {
          publishedCount: published
        });
      }
    } catch (error) {
      this.logger.error('Failed to process publish queue:', error);
      
      await this.logAutomationEvent('queue_processing', 'error', {
        error: error.message
      });
    }
  }

  async collectDailyAnalytics() {
    try {
      this.logger.info('Starting daily analytics collection...');
      
      // Get recently published videos
      const recentVideos = await this.getRecentlyPublishedVideos(7);
      
      let processedCount = 0;
      
      for (const video of recentVideos) {
        try {
          await this.agents.analytics.analyzeVideoPerformance(video.youtube_id);
          processedCount++;
          
          this.logger.info(`Analyzed video: ${video.title}`);
          
          // Small delay to avoid API rate limits
          await this.sleep(2000);
        } catch (error) {
          this.logger.error(`Failed to analyze video ${video.youtube_id}:`, error);
        }
      }

      this.logger.success(`Analytics collection completed. Processed ${processedCount} videos`);
      
      await this.logAutomationEvent('analytics_collection', 'success', {
        videosProcessed: processedCount
      });

    } catch (error) {
      this.logger.error('Daily analytics collection failed:', error);
      
      await this.logAutomationEvent('analytics_collection', 'error', {
        error: error.message
      });
    }
  }

  async weeklyStrategyReview() {
    try {
      this.logger.info('Starting weekly strategy review...');
      
      // Analyze performance of last week's content
      const weeklyAnalytics = await this.agents.analytics.getRecentAnalytics(7);
      
      // Update content strategy based on performance
      if (weeklyAnalytics.topPerformers.length > 0) {
        const bestPerformingTopics = weeklyAnalytics.topPerformers
          .map(video => video.videoDetails.title)
          .slice(0, 3);
        
        this.logger.info(`Top performing topics: ${bestPerformingTopics.join(', ')}`);
      }

      // Optimize publishing times
      await this.agents.publishing.optimizePublishTimes();
      
      // Generate strategy insights
      const insights = await this.generateWeeklyInsights(weeklyAnalytics);
      
      this.logger.success('Weekly strategy review completed');
      
      await this.logAutomationEvent('weekly_strategy_review', 'success', {
        insights
      });

    } catch (error) {
      this.logger.error('Weekly strategy review failed:', error);
      
      await this.logAutomationEvent('weekly_strategy_review', 'error', {
        error: error.message
      });
    }
  }

  async runDailyOptimization() {
    try {
      this.logger.info('Starting daily optimization tasks...');
      
      // Optimize existing content SEO
      await this.optimizeExistingContent();
      
      // Update keyword performance data
      await this.updateKeywordPerformance();
      
      // Clean up old files
      await this.cleanupOldFiles();
      
      this.logger.success('Daily optimization completed');
      
      await this.logAutomationEvent('daily_optimization', 'success');

    } catch (error) {
      this.logger.error('Daily optimization failed:', error);
      
      await this.logAutomationEvent('daily_optimization', 'error', {
        error: error.message
      });
    }
  }

  async databaseMaintenance() {
    try {
      this.logger.info('Starting database maintenance...');
      
      // Create backup
      const backupPath = await this.db.backup();
      this.logger.info(`Database backed up to: ${backupPath}`);
      
      // Get database stats
      const stats = await this.db.getStats();
      this.logger.info(`Database stats: ${JSON.stringify(stats)}`);
      
      // Clean old analytics data (older than 90 days)
      await this.cleanOldAnalytics();
      
      this.logger.success('Database maintenance completed');
      
      await this.logAutomationEvent('database_maintenance', 'success', {
        backupPath,
        stats
      });

    } catch (error) {
      this.logger.error('Database maintenance failed:', error);
      
      await this.logAutomationEvent('database_maintenance', 'error', {
        error: error.message
      });
    }
  }

  // Helper methods
  async getRecentlyPublishedVideos(days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const rows = await this.db.getAllRows(
      `SELECT * FROM publish_schedule 
       WHERE status = 'published' AND published_at > ?
       ORDER BY published_at DESC`,
      [cutoffDate.toISOString()]
    );
    
    return rows;
  }

  async generateWeeklyInsights(analytics) {
    const insights = [];
    
    if (analytics.averagePerformanceScore > 80) {
      insights.push('Content performance is excellent this week');
    } else if (analytics.averagePerformanceScore < 50) {
      insights.push('Content performance needs improvement');
    }
    
    if (analytics.topPerformers.length > 0) {
      insights.push(`Best performing video: ${analytics.topPerformers[0].videoDetails.title}`);
    }
    
    return insights;
  }

  async optimizeExistingContent() {
    // Get videos published in last 30 days with low performance
    const lowPerformingVideos = await this.db.getAllRows(
      `SELECT ar.* FROM analytics_reports ar
       JOIN publish_schedule ps ON ar.video_id = ps.id
       WHERE ar.performance_score < 50 
       AND ps.published_at > datetime('now', '-30 days')
       LIMIT 5`
    );
    
    for (const video of lowPerformingVideos) {
      // Re-analyze and generate optimization suggestions
      await this.agents.analytics.analyzeVideoPerformance(video.video_id);
      this.logger.info(`Re-analyzed low performing video: ${video.video_id}`);
    }
  }

  async updateKeywordPerformance() {
    // Update keyword performance based on recent analytics
    const recentVideos = await this.getRecentlyPublishedVideos(7);
    
    for (const video of recentVideos) {
      const analyticsData = await this.db.getRow(
        'SELECT * FROM analytics_reports WHERE video_id = ?',
        [video.id]
      );
      
      if (analyticsData) {
        const videoDetails = JSON.parse(analyticsData.video_details);
        const keywords = videoDetails.tags || [];
        
        for (const keyword of keywords) {
          await this.db.updateKeywordPerformance(
            keyword,
            videoDetails.statistics.viewCount,
            video.youtube_id
          );
        }
      }
    }
  }

  async cleanupOldFiles() {
    // Clean up temporary files older than 7 days
    const fs = require('fs').promises;
    const path = require('path');
    
    const tempDir = path.join(__dirname, '..', 'temp');
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    
    try {
      await this.cleanDirectoryOldFiles(tempDir, 7);
      await this.cleanDirectoryOldFiles(uploadsDir, 30);
      this.logger.info('Old files cleaned up');
    } catch (error) {
      this.logger.error('Failed to clean up old files:', error);
    }
  }

  async cleanDirectoryOldFiles(directory, days) {
    const fs = require('fs').promises;
    const path = require('path');
    
    try {
      const files = await fs.readdir(directory);
      const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      // Directory might not exist, which is fine
    }
  }

  async cleanOldAnalytics() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    await this.db.executeQuery(
      'DELETE FROM analytics_reports WHERE analyzed_at < ?',
      [cutoffDate.toISOString()]
    );
  }

  async logAutomationEvent(eventType, status, data = {}) {
    // Redact before persisting — provider errors can embed an API key from the
    // request URL, and this row is surfaced in the dashboard failures panel.
    const { redactSecrets } = require('../utils/logger');
    await this.db.executeQuery(
      'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
      [eventType, status, redactSecrets(JSON.stringify(data))]
    );
  }

  async sendFailureNotification(taskName, error) {
    this.logger.error(`AUTOMATION FAILURE - ${taskName}: ${error.message}`);

    // Surface the failure on the Mac itself — a silent log line means a lost
    // day of content goes unnoticed. osascript needs no extra dependencies.
    try {
      const { exec } = require('child_process');
      const title = `Vid Shock: ${taskName} FAILED`.replace(/"/g, "'");
      const body = String(error.message || error).slice(0, 200).replace(/"/g, "'");
      exec(
        `osascript -e "display notification \\"${body}\\" with title \\"${title}\\" sound name \\"Basso\\""`,
        () => {} // notification failure must never crash the scheduler
      );
    } catch (_) { /* never let notification errors mask the original failure */ }
  }

  async syncVideoPerformance() {
    this.logger.info('Syncing video performance from YouTube...');
    try {
      const youtube = this.agents.publishing.youtube;
      if (!youtube) return;

      const tracked = await this.db.getTrackedVideos();
      if (!tracked.length) {
        this.logger.info('No tracked videos yet, skipping performance sync');
        return;
      }

      // Fetch stats in batches of 50 (YouTube API limit)
      const ids = tracked.map(v => v.youtube_id).filter(Boolean);
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const res = await youtube.videos.list({
          part: 'statistics',
          id: batch.join(',')
        });
        for (const item of (res.data.items || [])) {
          const views = parseInt(item.statistics.viewCount) || 0;
          const likes = parseInt(item.statistics.likeCount) || 0;
          await this.db.updateVideoViews(item.id, views, likes);
          this.logger.info(`Updated ${item.id}: ${views} views`);
        }
      }
      this.logger.info('Performance sync complete');
    } catch (error) {
      this.logger.error('Performance sync failed:', error.message);
    }
  }

  startMonitoringLoop() {
    // Monitor system health every hour
    setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error('Health check failed:', error);
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  async performHealthCheck() {
    const health = {
      timestamp: new Date().toISOString(),
      database: false,
      agents: {},
      scheduledTasks: {},
      systemResources: {}
    };

    // Check database
    try {
      await this.db.getAllRows('SELECT 1');
      health.database = true;
    } catch (error) {
      health.database = false;
    }

    // Check scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      health.scheduledTasks[name] = task.running;
    });

    // Get system resources (simplified)
    health.systemResources = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version
    };

    // Log health status
    const healthScore = this.calculateHealthScore(health);
    
    if (healthScore < 80) {
      this.logger.warn(`System health score: ${healthScore}/100`, health);
    } else {
      this.logger.info(`System health check passed: ${healthScore}/100`);
    }
    
    return health;
  }

  calculateHealthScore(health) {
    let score = 100;
    
    if (!health.database) score -= 30;
    
    const tasksRunning = Object.values(health.scheduledTasks).filter(Boolean).length;
    const totalTasks = Object.keys(health.scheduledTasks).length;
    
    if (totalTasks > 0 && tasksRunning < totalTasks) {
      score -= ((totalTasks - tasksRunning) / totalTasks) * 20;
    }
    
    return Math.max(0, Math.round(score));
  }

  // Control methods
  async pauseAutomation() {
    this.isEnabled = false;
    this.logger.info('Automation paused');
  }

  async resumeAutomation() {
    this.isEnabled = true;
    this.logger.info('Automation resumed');
  }

  async stopAutomation() {
    this.scheduledTasks.forEach((task, name) => {
      task.stop();
      this.logger.info(`Stopped scheduled task: ${name}`);
    });
    
    this.isEnabled = false;
    this.logger.info('All automation tasks stopped');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getAutomationStatus() {
    return {
      enabled: this.isEnabled,
      scheduledTasks: Array.from(this.scheduledTasks.keys()).map(name => ({
        name,
        running: this.scheduledTasks.get(name).running
      })),
      lastHealthCheck: this.lastHealthCheck,
      uptime: process.uptime()
    };
  }
}

module.exports = { DailyAutomation };