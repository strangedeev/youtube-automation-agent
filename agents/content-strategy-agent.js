const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Logger } = require('../utils/logger');

class ContentStrategyAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ContentStrategy');
    this.trendingTopics = [];
    this.competitorData = [];
    this.contentCalendar = [];

    const geminiKey = credentials.credentials?.gemini?.apiKey;
    if (geminiKey) {
      const genAI = new GoogleGenerativeAI(geminiKey);
      this.gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    }
  }

  async initialize() {
    this.logger.info('Initializing Content Strategy Agent...');
    await this.loadHistoricalData();
    await this.analyzeTrends();
    return true;
  }

  async loadHistoricalData() {
    try {
      const history = await this.db.getContentHistory();
      this.historicalPerformance = history;
    } catch (error) {
      this.logger.warn('No historical data found, starting fresh');
      this.historicalPerformance = [];
    }
  }

  async analyzeTrends() {
    try {
      // Analyze YouTube trends
      const trends = await this.fetchYouTubeTrends();
      
      // Analyze competitor channels
      const competitors = await this.analyzeCompetitors();
      
      // Combine insights
      this.trendingTopics = this.mergeTrendData(trends, competitors);
      
      this.logger.info(`Identified ${this.trendingTopics.length} trending topics`);
    } catch (error) {
      this.logger.error('Error analyzing trends:', error);
    }
  }

  async fetchYouTubeTrends() {
    // Use YouTube API to fetch trending videos
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.videos.list({
        part: 'snippet,statistics',
        chart: 'mostPopular',
        maxResults: 50,
        regionCode: process.env.YOUTUBE_REGION || 'US'
      });

      return response.data.items.map(video => ({
        title: video.snippet.title,
        tags: video.snippet.tags || [],
        viewCount: parseInt(video.statistics.viewCount),
        category: video.snippet.categoryId,
        publishedAt: video.snippet.publishedAt
      }));
    } catch (error) {
      this.logger.error('Failed to fetch YouTube trends:', error);
      return [];
    }
  }

  async analyzeCompetitors() {
    const competitorChannels = (process.env.COMPETITOR_CHANNELS || '').split(',');
    const competitorData = [];

    for (const channelId of competitorChannels) {
      if (!channelId) continue;
      
      try {
        const videos = await this.getChannelVideos(channelId);
        const analysis = this.analyzeVideoPerformance(videos);
        competitorData.push({
          channelId,
          topPerformingTopics: analysis.topTopics,
          averageViews: analysis.avgViews,
          uploadFrequency: analysis.frequency
        });
      } catch (error) {
        this.logger.error(`Failed to analyze competitor ${channelId}:`, error);
      }
    }

    return competitorData;
  }

  async getChannelVideos(channelId) {
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.search.list({
        part: 'snippet',
        channelId: channelId,
        maxResults: 20,
        order: 'date',
        type: 'video'
      });

      const videoIds = response.data.items.map(item => item.id.videoId).join(',');
      
      const videoDetails = await youtube.videos.list({
        part: 'statistics,snippet',
        id: videoIds
      });

      return videoDetails.data.items;
    } catch (error) {
      this.logger.error(`Failed to get videos for channel ${channelId}:`, error);
      return [];
    }
  }

  analyzeVideoPerformance(videos) {
    if (!videos || videos.length === 0) {
      return { topTopics: [], avgViews: 0, frequency: 0 };
    }

    const topics = {};
    let totalViews = 0;

    videos.forEach(video => {
      const title = video.snippet.title.toLowerCase();
      const views = parseInt(video.statistics.viewCount);
      totalViews += views;

      // Extract topics from title
      const keywords = this.extractKeywords(title);
      keywords.forEach(keyword => {
        if (!topics[keyword]) topics[keyword] = { count: 0, views: 0 };
        topics[keyword].count++;
        topics[keyword].views += views;
      });
    });

    const topTopics = Object.entries(topics)
      .sort((a, b) => b[1].views - a[1].views)
      .slice(0, 10)
      .map(([topic, data]) => ({ topic, avgViews: data.views / data.count }));

    return {
      topTopics,
      avgViews: totalViews / videos.length,
      frequency: videos.length
    };
  }

  extractKeywords(text) {
    // Simple keyword extraction
    const stopWords = ['the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'as', 'are', 'was', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'could', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now'];
    
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.includes(word));
  }

  mergeTrendData(trends, competitors) {
    const mergedTopics = new Map();

    // Add trending topics — use full cleaned titles as topics, not individual words
    trends.forEach(trend => {
      const topic = trend.title
        .replace(/\s*[\|#@]\s*.*/g, '')   // strip | # @ suffixes
        .replace(/\s*[-–]\s*\w+TV$|\s*[-–]\s*\w+Channel$/i, '') // strip channel names
        .replace(/["""'']/g, '')
        .trim();
      if (!topic || topic.length < 5) return;
      if (!mergedTopics.has(topic)) {
        mergedTopics.set(topic, { score: 0, sources: [] });
      }
      const topicData = mergedTopics.get(topic);
      topicData.score += trend.viewCount / 1000000;
      topicData.sources.push('trending');
    });

    // Add competitor topics
    competitors.forEach(competitor => {
      if (competitor.topPerformingTopics) {
        competitor.topPerformingTopics.forEach(({ topic, avgViews }) => {
          if (!mergedTopics.has(topic)) {
            mergedTopics.set(topic, { score: 0, sources: [] });
          }
          const topicData = mergedTopics.get(topic);
          topicData.score += avgViews / 100000; // Normalize
          topicData.sources.push('competitor');
        });
      }
    });

    // Convert to array and sort by score
    return Array.from(mergedTopics.entries())
      .map(([topic, data]) => ({ topic, ...data }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  // ── Reddit story fetching ─────────────────────────────────────────────────
  // Pulls a top post from one of the high-performing story subreddits.
  // Returns { topic, fullStory, subreddit, redditId, score, url } or null.
  // Score a Reddit post for its video potential.
  // Returns 0-100. Higher = better story for YouTube Shorts narration.
  scoreStoryQuality(post) {
    const text = (post.title + ' ' + post.selftext).toLowerCase();
    let score = 0;

    // ── Conflict / antagonist signals ────────────────────────────────────
    // Good stories have a clear bad guy or unfair situation
    const conflictWords = ['refused', 'told me', 'she said', 'he said', 'they said',
      'threatened', 'accused', 'fired', 'kicked out', 'dumped', 'cheated',
      'stolen', 'lied', 'manipulated', 'blocked', 'excluded', 'humiliated'];
    conflictWords.forEach(w => { if (text.includes(w)) score += 4; });

    // ── Resolution / satisfying ending signals ───────────────────────────
    // Stories with a payoff retain viewers to the end
    const resolutionWords = ['so i', 'ended up', 'finally', 'turns out', 'update:',
      'karma', 'got fired', 'apologised', 'apologized', 'called the police',
      'left him', 'left her', 'broke up', 'revenge', 'justice', 'won',
      'paid back', 'exposed', 'caught'];
    resolutionWords.forEach(w => { if (text.includes(w)) score += 5; });

    // ── Emotional escalation signals ─────────────────────────────────────
    const emotionWords = ['unbelievable', 'furious', 'shocked', 'disgusted',
      'devastated', 'livid', 'betrayed', 'heartbroken', 'humiliated', 'outraged'];
    emotionWords.forEach(w => { if (text.includes(w)) score += 3; });

    // ── Reddit verdict posts (AITA, AITAH) tend to have clean story arcs ─
    if (/\b(aita|aitah|wibta)\b/.test(text)) score += 10;

    // ── Length sweet spot: 500-6000 chars = 1-4 min narration ───────────
    const len = post.selftext.length;
    if (len >= 500 && len <= 6000) score += 15;
    else if (len > 6000 && len <= 15000) score += 8;
    else if (len > 15000) score += 3;   // very long but still usable

    // ── Popularity signal ────────────────────────────────────────────────
    if (post.score >= 5000) score += 10;
    else if (post.score >= 1000) score += 6;
    else if (post.score >= 500) score += 3;

    return Math.min(100, score);
  }

  async fetchRedditStory() {
    const subreddits = [
      'AmItheAsshole',
      'AITAH',
      'tifu',
      'pettyrevenge',
      'MaliciousCompliance',
      'ProRevenge',
      'NuclearRevenge',
      'relationship_advice',
      'entitledparents',
      'ChoosingBeggars',
      'antiwork',
      'TalesFromRetail',
      'TalesFromTechSupport',
      'IDontWorkHereLady',
      'confessions',
      'TrueOffMyChest',
      'AmIOverreacting'
    ];

    // Shuffle so we don't always hit the same subreddit first
    const shuffled = subreddits.sort(() => Math.random() - 0.5);
    const recentTopics = this.getRecentTopics();

    // Try every subreddit until we find a qualifying post — don't give up after one
    for (const sub of shuffled) {
      const url = `https://www.reddit.com/r/${sub}/top.json?t=week&limit=50&raw_json=1`;

      try {
        this.logger.info(`Fetching Reddit stories from r/${sub}...`);
        const response = await axios.get(url, {
          // Identify by the project rather than the channel — a User-Agent
          // should be a stable identifier, not something a rename invalidates.
          headers: { 'User-Agent': 'youtube-automation-agent/1.0' },
          timeout: 15000
        });

        const posts = response.data?.data?.children || [];

        // Filter: basic quality gates — no length cap, let scoring decide
        const candidates = posts
          .map(p => p.data)
          .filter(p =>
            p.is_self &&
            p.selftext &&
            p.selftext !== '[removed]' &&
            p.selftext !== '[deleted]' &&
            p.selftext.length > 300 &&    // minimum: enough to narrate
            p.score > 100 &&
            !p.stickied &&
            !p.over_18 &&
            !recentTopics.includes(p.title)
          )
          // Score each post and sort by story quality, not just upvotes
          .map(p => ({ ...p, _storyScore: this.scoreStoryQuality(p) }))
          .sort((a, b) => b._storyScore - a._storyScore);

        if (!candidates.length) {
          this.logger.warn(`No suitable posts in r/${sub}, trying next...`);
          continue;
        }

        // Only consider posts with a minimum story score — skip low-quality vents
        const goodCandidates = candidates.filter(p => p._storyScore >= 20);
        if (!goodCandidates.length) {
          this.logger.warn(`Posts in r/${sub} scored too low, trying next...`);
          continue;
        }

        // Pick from top 3 best-scoring posts for variety
        const pick = goodCandidates[Math.floor(Math.random() * Math.min(3, goodCandidates.length))];
        this.logger.info(`Selected: "${pick.title}" (score: ${pick.score}, story: ${pick._storyScore}/100) from r/${sub}`);

        return {
          topic: pick.title,
          fullStory: pick.selftext,
          subreddit: sub,
          redditId: pick.id,
          score: pick.score,
          storyScore: pick._storyScore,
          url: `https://www.reddit.com${pick.permalink}`
        };
      } catch (err) {
        this.logger.warn(`Reddit fetch failed for r/${sub}: ${err.message}`);
        continue;
      }
    }

    this.logger.warn('All subreddits exhausted — no Reddit story found, falling back to fact topic');
    return null;
  }

  // ── Topic configuration ──────────────────────────────────────────────────
  // Users pick their own niche by creating config/topics.json (copy from
  // config/topics.example.json). It holds:
  //   { "contentStyle": "<how stories should sound>", "topics": ["...", "..."] }
  // If absent, we fall back to the built-in default topic set below so the tool
  // works out of the box. The full story is written by the script writer (NIM);
  // this method only PICKS what each video is about.
  loadTopicsConfig(format = 'short') {
    try {
      const filename = format === 'long' ? 'topics-longform.json' : 'topics.json';
      const p = path.join(__dirname, '..', 'config', filename);
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        // New multi-angle schema: { category, angles: [{ id, weight, contentStyle, topics }] }
        if (Array.isArray(cfg.angles) && cfg.angles.some(a => Array.isArray(a.topics) && a.topics.length)) {
          return cfg;
        }
        // Legacy flat schema: { contentStyle, topics: [...] }
        if (Array.isArray(cfg.topics) && cfg.topics.length) return cfg;
      }
    } catch (e) {
      this.logger.warn(`Could not read config/topics.json: ${e.message}`);
    }
    return null;
  }

  // Weighted random pick of an angle block. weight defaults to 1, multiplied
  // by that angle's real performance factor (see getAnglePerformance) so
  // better-performing niches get picked more often — without ever fully
  // starving a low-sample or currently-weaker angle (floor of 0.5x).
  pickAngle(angles, perfMap = {}) {
    const usable = angles.filter(a => Array.isArray(a.topics) && a.topics.length);
    const effectiveWeight = (a) => (a.weight || 1) * (perfMap[a.id] ?? 1);
    const total = usable.reduce((s, a) => s + effectiveWeight(a), 0);
    let r = Math.random() * total;
    for (const a of usable) {
      r -= effectiveWeight(a);
      if (r <= 0) return a;
    }
    return usable[usable.length - 1];
  }

  // Fetch real YouTube view counts per angle for this format, and convert
  // them into a weight multiplier. Cached for an hour so every generation
  // doesn't burn a YouTube API + Data API round trip.
  // Multiplier is clamped to [0.5, 2.0] and only applied once an angle has at
  // least MIN_SAMPLE published videos — below that, one lucky/unlucky video
  // isn't enough signal to bias selection, so it stays neutral (1x).
  async getAnglePerformance(format) {
    const MIN_SAMPLE = 3;
    const CACHE_MS = 60 * 60 * 1000;
    // Only consider reasonably recent uploads — a video from six months ago
    // says little about what the algorithm rewards today.
    const LOOKBACK_DAYS = 90;
    // A week where the median video got fewer than this many views means the
    // algorithm simply wasn't distributing the channel at all. Those videos
    // carry no information about which ANGLE is good, so they're excluded.
    const DISTRIBUTION_FLOOR = 5;

    this._anglePerfCache = this._anglePerfCache || {};
    const cached = this._anglePerfCache[format];
    if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.data;

    try {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
      const rows = await this.db.getAllRows(
        `SELECT angle, youtube_id, published_at FROM publish_schedule
         WHERE status = 'published' AND angle IS NOT NULL AND youtube_id IS NOT NULL
           AND format = ? AND published_at IS NOT NULL AND published_at >= ?`,
        [format, since]
      );
      if (!rows.length) return {};

      const youtube = this.credentials.getYouTubeClient();
      const viewsById = {};
      const BATCH = 50;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const ids = batch.map(r => r.youtube_id).join(',');
        const resp = await youtube.videos.list({ part: 'statistics', id: ids });
        for (const item of resp.data.items || []) {
          viewsById[item.id] = parseInt(item.statistics?.viewCount || 0, 10);
        }
      }

      // Compare each video only against others published around the same time.
      //
      // Raw lifetime averages are badly misleading here: this channel sat at
      // ~0 views for weeks before the Shorts algorithm began distributing it.
      // An angle that happened to post mostly during the quiet stretch looked
      // terrible, and one that posted during a push looked great — the metric
      // was really measuring WHEN a video went out, not how good it was.
      //
      // So bucket by week, take that week's median as the "distribution
      // weather", and score every video relative to it. A video that doubled
      // its week's median scores 2.0 whether the week was big or small.
      const weekOf = iso => {
        const d = new Date(iso);
        return isNaN(d) ? null : Math.floor(d.getTime() / (7 * 864e5));
      };
      const median = arr => {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      };

      const buckets = {};
      for (const r of rows) {
        const v = viewsById[r.youtube_id];
        const w = weekOf(r.published_at);
        if (v === undefined || w === null) continue;
        (buckets[w] = buckets[w] || []).push({ angle: r.angle, views: v });
      }

      const byAngle = {};      // angle -> [relative scores]
      const rawByAngle = {};   // angle -> [raw views]  (reporting only)
      let skippedWeeks = 0;
      for (const entries of Object.values(buckets)) {
        const med = median(entries.map(e => e.views));
        if (med < DISTRIBUTION_FLOOR) { skippedWeeks++; continue; }
        for (const e of entries) {
          (byAngle[e.angle] = byAngle[e.angle] || []).push(e.views / med);
          (rawByAngle[e.angle] = rawByAngle[e.angle] || []).push(e.views);
        }
      }

      if (!Object.keys(byAngle).length) {
        this.logger.info(`Angle performance (${format}): no weeks above the distribution floor yet — neutral weights`);
        return {};
      }

      const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
      const perfMap = {};
      const report = [];
      for (const [angle, scores] of Object.entries(byAngle)) {
        // A relative score of 1.0 is "typical for its week", so it maps
        // straight onto the weight multiplier.
        const multiplier = scores.length < MIN_SAMPLE
          ? 1
          : Math.max(0.5, Math.min(2.0, mean(scores)));
        perfMap[angle] = multiplier;
        report.push({
          angle,
          avgViews: Math.round(mean(rawByAngle[angle])),
          relScore: Math.round(mean(scores) * 100) / 100,
          sampleSize: scores.length,
          multiplier
        });
      }
      report.sort((a, b) => b.relScore - a.relScore);

      this.logger.info(
        `Angle performance (${format}, ${skippedWeeks} low-distribution week(s) excluded): ` +
        Object.entries(perfMap).map(([a, m]) => `${a}=${m.toFixed(2)}x`).join(', ')
      );
      this._anglePerfCache[format] = { data: perfMap, report, fetchedAt: Date.now() };
      return perfMap;
    } catch (e) {
      this.logger.warn(`Angle performance lookup failed (${e.message}) — using neutral weights`);
      return {};
    }
  }

  // Human-readable version for the dashboard — reuses the same cache as
  // getAnglePerformance so viewing the report never costs an extra API call.
  async getAnglePerformanceReport(format) {
    await this.getAnglePerformance(format);
    return this._anglePerfCache?.[format]?.report || [];
  }

  async selectStoryPremise(format = 'short') {
    const recentTopics = this.getRecentTopics();

    // 1. User-defined topics take priority (config/topics.json or config/topics-longform.json)
    const userCfg = this.loadTopicsConfig(format);
    if (userCfg) {
      // ── Multi-angle schema ──────────────────────────────────────────────
      // Each run picks one angle (weighted), then a fresh topic from it. The
      // angle id + its contentStyle thread through to the script writer so each
      // video is written in the right FORMAT (story vs fact vs prediction…).
      if (Array.isArray(userCfg.angles)) {
        const perfMap = await this.getAnglePerformance(format);
        const angle = this.pickAngle(userCfg.angles, perfMap);
        const fresh = angle.topics.filter(t => !recentTopics.includes(t));
        const pool  = fresh.length ? fresh : angle.topics;
        const pick  = pool[Math.floor(Math.random() * pool.length)];
        this.logger.info(`Selected topic [angle: ${angle.id}] (from config/topics.json): "${pick}"`);
        return {
          topic:        pick,
          premise:      pick,
          category:     userCfg.category || 'Custom',
          contentStyle: angle.contentStyle || null,
          angle:        angle.id || 'story',
          isOriginal:   true
        };
      }

      // ── Legacy flat schema ──────────────────────────────────────────────
      const fresh = userCfg.topics.filter(t => !recentTopics.includes(t));
      const pool  = fresh.length ? fresh : userCfg.topics;
      const pick  = pool[Math.floor(Math.random() * pool.length)];
      this.logger.info(`Selected topic (from config/topics.json): "${pick}"`);
      return {
        topic:        pick,
        premise:      pick,
        category:     userCfg.category || 'Custom',
        contentStyle: userCfg.contentStyle || null,
        angle:        'story',
        isOriginal:   true
      };
    }

    // 2. Built-in default topic bank (dramatic first-person stories)
    const premiseBank = {
      'Relationship Betrayal': [
        'My girlfriend was caught cheating, and her excuse made it ten times worse',
        'My husband has been hiding a second phone for our entire marriage',
        'I found my fiancé\'s secret dating profile a week before the wedding',
        'My wife\'s "work trips" were not work trips, and the truth gutted me',
        'My partner\'s best friend told me a secret that ended our relationship'
      ],
      'Family Drama': [
        'My parents are gold diggers and they tried to use my inheritance',
        'My sister stole my identity and lived a double life for years',
        'My mother chose my abuser over me, and I finally walked away',
        'My in-laws hired a private investigator to dig up dirt before my wedding',
        'My brother forged our late father\'s will and nearly got away with it'
      ],
      'Workplace Injustice': [
        'My boss fired me for a mistake he actually made five years ago',
        'I caught my coworkers running a betting pool on my divorce',
        'My manager stole my project, took the promotion, then asked for my help',
        'HR sided with my harasser until I showed them what I had recorded',
        'I trained my replacement before realizing they were hired to replace me'
      ],
      'Neighbor & Stranger': [
        'I caught my neighbor using my backyard for illegal midnight deliveries',
        'My landlord installed hidden microphones to spy on every tenant',
        'A stranger at my door knew details about my life he should not have',
        'My new neighbor slowly tried to claim half of my property as theirs',
        'The friendly old man next door was not who everyone thought he was'
      ],
      'Dark Discovery': [
        'I found a hidden camera in a gift from my lifelong best friend',
        'I found journals proving my late father led a completely different life',
        'I inherited a locked safe and its contents destroyed my family',
        'I discovered the charity I donated to for years was completely fabricated',
        'My therapist was using my trauma as plots for her bestselling novels'
      ],
      'Friendship Betrayal': [
        'My closest friend has been secretly dating my ex for two years',
        'My childhood best friend opened credit cards in my name across three states',
        'My maid of honor tried to sabotage my wedding to take my place',
        'My best friend faked an entire illness for sympathy and money',
        'The friend I supported through everything testified against me in court'
      ]
    };

    const categories = Object.keys(premiseBank);

    // Flatten to (category, premise) pairs, prefer ones not recently used
    const allPairs = categories.flatMap(cat =>
      premiseBank[cat].map(premise => ({ category: cat, premise }))
    );
    const fresh = allPairs.filter(p => !recentTopics.includes(p.premise));
    const pool  = fresh.length > 0 ? fresh : allPairs;
    const pick  = pool[Math.floor(Math.random() * pool.length)];

    this.logger.info(`Selected original premise [${pick.category}]: "${pick.premise}"`);
    return {
      topic:       pick.premise,
      premise:     pick.premise,
      category:    pick.category,
      isOriginal:  true
    };
  }

  async generateViralShortsTopic() {
    if (!this.gemini) return null;

    const recentTopics = this.getRecentTopics();
    const avoidList = recentTopics.length > 0
      ? `\nAvoid these recently used topics: ${recentTopics.slice(0, 5).join(', ')}`
      : '';

    // Pull top-performing topic categories from the DB to bias future topics
    let performanceHint = '';
    try {
      const topPerformers = await this.db.getTopPerformingTopics(3);
      if (topPerformers.length > 0) {
        const examples = topPerformers.map(t => `"${t.topic}" (avg ${Math.round(t.avg_views)} views)`).join(', ');
        performanceHint = `\nOur best-performing topics so far: ${examples}. Lean into similar subject areas.`;
      }
    } catch (_) {}


    // Use currently trending YouTube titles to inform topic selection
    let trendingContext = '';
    try {
      const trending = await this.fetchYouTubeTrends();
      if (trending.length > 0) {
        const titles = trending
          .sort((a, b) => b.viewCount - a.viewCount)
          .slice(0, 8)
          .map(t => `"${t.title}"`)
          .join(', ');
        trendingContext = `\n\nCurrently trending on YouTube (high viewcount right now): ${titles}.\nIf any of these suggest a real historical, scientific, or psychological angle worth exploring — use them as a springboard. For example, if "Titanic" is trending, don't cover the sinking — cover "The Metallurgical Flaw That Made Titanic's Hull Shatter Instead Of Bend". If nothing is relevant, ignore this list entirely.`;
      }
    } catch (_) {}

    // Rotate through 10 content pillars — keeps every video feeling fresh
    const pillars = [
      { name: 'Psychology', hint: 'Shocking facts about how the human brain works against you — e.g. "Your brain is lying to you right now and you can\'t stop it"' },
      { name: 'Body Horror', hint: 'Disturbing things happening inside your body right now — e.g. "Right now millions of mites are living on your face"' },
      { name: 'Animal Facts', hint: 'Impossible-sounding but real animal abilities — e.g. "This animal punches faster than a bullet"' },
      { name: 'Space Dread', hint: 'Terrifying and mind-bending space facts — e.g. "The nearest black hole is close enough to affect Earth right now"' },
      { name: 'True Crime', hint: 'A real crime or mystery that can be told in 20 seconds — specific names, dates, numbers only' },
      { name: 'Dark History', hint: 'History that sounds fake but actually happened — e.g. "The Roman Emperor who declared war on the ocean"' },
      { name: 'Impossible Science', hint: 'Proven science that sounds like a conspiracy theory — e.g. "NASA broadcast something live in 1977 they still haven\'t explained"' },
      { name: 'Dark Side of Everyday Things', hint: 'The sinister truth behind ordinary objects or habits — e.g. "The reason your phone charger gets warm is actually terrifying"' },
      { name: 'Social Experiments', hint: 'Famous psychology experiments and their shocking results — e.g. Stanford Prison Experiment, Milgram obedience study' },
      { name: 'Records & Extremes', hint: 'The extreme limits of humans or nature — e.g. "The deepest free dive ever and what the diver saw at the bottom"' },
    ];
    const pillar = pillars[Math.floor(Math.random() * pillars.length)];

    const prompt = `You are generating a topic for a viral English YouTube Shorts channel.

Today's pillar: **${pillar.name}**
Style hint: ${pillar.hint}

Generate one very specific topic within this pillar. Don't stay surface-level — find a sharp, specific angle on a real event, experiment, or fact.

Good examples:
- Not "Chernobyl" but "In 1986 Soviet engineers pressed the emergency stop button on a runaway reactor — and the button itself caused the explosion"
- Not "deep ocean" but "In 1960 two men reached the deepest point in the ocean and found a living fish nobody expected to be there"

Rules:
- Must be factual and verifiable
- Must have one sharp specific angle that makes viewers feel "I never knew that"
- No celebrities, movies, or pop culture
- English only${avoidList}${performanceHint}${trendingContext}

Write only the topic title — one sentence in English. No quotes, no explanation.`;

    try {
      const result = await this.gemini.generateContent(prompt);
      const topic = result.response.text().trim().replace(/^["']|["']$/g, '');
      this.logger.info(`Gemini generated topic: ${topic}`);
      return topic || null;
    } catch (error) {
      this.logger.error('Gemini topic generation failed:', error.message);
      return null;
    }
  }

  async generateContentStrategy(requestedTopic = null, format = 'short') {
    try {
      let topic, angle, targetAudience, contentType;
      let premiseData = null;

      // The agent is long-lived under PM2 — refresh history each run so
      // yesterday's publish is visible to today's dedup window.
      await this.loadHistoricalData();

      if (requestedTopic) {
        // Manual override — treat the requested topic as an original story premise.
        // A typed-in topic uses the default story format unless the user prefixed
        // an angle, e.g. "facts: world cup records" / "prediction: who wins 2026".
        const m = String(requestedTopic).match(/^\s*(story|facts|prediction|recap)\s*:\s*(.+)$/i);
        const cleanTopic = m ? m[2].trim() : requestedTopic;
        const reqAngle   = m ? m[1].toLowerCase() : 'story';
        topic = cleanTopic;
        angle = 'Original drama story';
        premiseData = { topic: cleanTopic, premise: cleanTopic, category: 'Custom', angle: reqAngle, isOriginal: true };
      } else {
        // ── Original story premise — the channel's primary (and only) format ──
        // The script writer turns this premise into a full original story via NIM.
        premiseData = await this.selectStoryPremise(format);
        topic = premiseData.topic;
        angle = 'Original drama story';
      }

      // Determine target audience
      targetAudience = await this.identifyTargetAudience(topic);

      // Always a story now
      contentType = 'Story';

      // Generate content calendar entry
      const strategy = {
        topic,
        angle,
        targetAudience,
        contentType,
        keywords: this.extractKeywords(topic),
        estimatedViews: this.predictViews(topic),
        bestPublishTime: this.calculateBestPublishTime(),
        competitorAnalysis: this.getCompetitorInsights(topic),
        // Original story fields — passed through to the script writer
        isOriginal:   true,
        premise:      premiseData.premise,
        category:     premiseData.category,
        contentStyle: premiseData.contentStyle || null,
        angle:        premiseData.angle || 'story',
        format,
        createdAt: new Date().toISOString()
      };

      // Save to database
      await this.db.saveContentStrategy(strategy);

      this.logger.info(`Generated strategy for: ${topic}`);
      return strategy;
    } catch (error) {
      this.logger.error('Failed to generate content strategy:', error);
      throw error;
    }
  }

  selectOptimalTopic() {
    // Use scoring algorithm to select best topic
    const recentTopics = this.getRecentTopics();
    
    const scoredTopics = this.trendingTopics
      .filter(topic => !recentTopics.includes(topic.topic))
      .map(topic => ({
        ...topic,
        finalScore: topic.score * this.getSeasonalMultiplier(topic.topic) * this.getAudienceMultiplier(topic.topic)
      }));

    return scoredTopics[0] || { topic: 'Technology Trends', score: 1 };
  }

  async generateAngle(topic) {
    // Generate unique angle for the topic
    const angles = [
      `The Ultimate Guide to ${topic}`,
      `${topic}: What Nobody Is Telling You`,
      `How ${topic} Will Change Everything in 2025`,
      `The Hidden Truth About ${topic}`,
      `${topic} Explained in 5 Minutes`,
      `Why ${topic} Is More Important Than You Think`,
      `${topic}: Expert Secrets Revealed`,
      `The Complete ${topic} Tutorial for Beginners`
    ];

    return angles[Math.floor(Math.random() * angles.length)];
  }

  async identifyTargetAudience(topic) {
    // Simplified audience identification
    const audiences = {
      tech: 'Tech enthusiasts, developers, early adopters',
      business: 'Entrepreneurs, business owners, professionals',
      education: 'Students, educators, lifelong learners',
      entertainment: 'General audience, entertainment seekers',
      lifestyle: 'Lifestyle enthusiasts, self-improvement seekers'
    };

    const category = this.categorize(topic);
    return audiences[category] || audiences.entertainment;
  }

  categorize(topic) {
    const categories = {
      tech: ['technology', 'software', 'app', 'ai', 'code', 'programming', 'crypto', 'blockchain'],
      business: ['business', 'money', 'finance', 'startup', 'entrepreneur', 'marketing'],
      education: ['learn', 'tutorial', 'how to', 'guide', 'course', 'study'],
      lifestyle: ['life', 'health', 'fitness', 'food', 'travel', 'fashion']
    };

    const topicLower = topic.toLowerCase();
    
    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => topicLower.includes(keyword))) {
        return category;
      }
    }

    return 'entertainment';
  }

  selectContentType(topic) {
    const types = [
      { type: 'Tutorial', suitableFor: ['how to', 'guide', 'learn'] },
      { type: 'List', suitableFor: ['best', 'top', 'worst'] },
      { type: 'Review', suitableFor: ['review', 'vs', 'comparison'] },
      { type: 'Explainer', suitableFor: ['what is', 'why', 'explained'] },
      { type: 'News', suitableFor: ['breaking', 'latest', 'new'] },
      { type: 'Story', suitableFor: ['story', 'journey', 'experience'] }
    ];

    const topicLower = topic.toLowerCase();
    
    for (const contentType of types) {
      if (contentType.suitableFor.some(keyword => topicLower.includes(keyword))) {
        return contentType.type;
      }
    }

    return 'Explainer';
  }

  predictViews(topic) {
    // Simplified view prediction based on topic score
    const topicData = this.trendingTopics.find(t => t.topic === topic);
    const baseViews = topicData ? topicData.score * 10000 : 5000;
    const variance = baseViews * 0.3;
    return Math.floor(baseViews + (Math.random() * variance * 2) - variance);
  }

  calculateBestPublishTime() {
    // Analyze best publishing times
    const bestTimes = [
      { day: 'Tuesday', hour: 14 },
      { day: 'Wednesday', hour: 14 },
      { day: 'Thursday', hour: 14 },
      { day: 'Friday', hour: 15 },
      { day: 'Saturday', hour: 10 },
      { day: 'Sunday', hour: 10 }
    ];

    const selected = bestTimes[Math.floor(Math.random() * bestTimes.length)];
    const nextDate = this.getNextWeekday(selected.day);
    nextDate.setHours(selected.hour, 0, 0, 0);
    
    return nextDate.toISOString();
  }

  getNextWeekday(dayName) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const targetDay = days.indexOf(dayName);
    const today = new Date();
    const currentDay = today.getDay();
    const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7;
    const nextDate = new Date(today);
    nextDate.setDate(today.getDate() + daysUntilTarget);
    return nextDate;
  }

  getCompetitorInsights(topic) {
    // Get insights from competitor analysis
    return this.competitorData
      .filter(competitor => 
        competitor.topPerformingTopics.some(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      )
      .map(competitor => ({
        channelId: competitor.channelId,
        averageViews: competitor.averageViews,
        relevantVideos: competitor.topPerformingTopics.filter(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      }));
  }

  getRecentTopics() {
    // 30-day window — full cycle before any topic repeats.
    // DB rows are snake_case (created_at); camelCase (createdAt) only exists on
    // in-session objects. Falling back to publish_date covers older rows.
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    return this.historicalPerformance
      .filter(content => {
        const raw = content.created_at || content.createdAt || content.publish_date;
        const contentDate = new Date(raw);
        return !isNaN(contentDate) && contentDate > monthAgo;
      })
      .map(content => content.topic);
  }

  getSeasonalMultiplier(topic) {
    // Adjust score based on seasonal relevance
    const month = new Date().getMonth();
    const seasonalTopics = {
      winter: ['christmas', 'holiday', 'new year', 'winter'],
      spring: ['spring', 'easter', 'garden'],
      summer: ['summer', 'vacation', 'beach', 'travel'],
      fall: ['halloween', 'thanksgiving', 'autumn', 'back to school']
    };

    const season = month < 3 ? 'winter' : month < 6 ? 'spring' : month < 9 ? 'summer' : 'fall';
    const topicLower = topic.toLowerCase();
    
    if (seasonalTopics[season].some(keyword => topicLower.includes(keyword))) {
      return 1.5;
    }
    
    return 1.0;
  }

  getAudienceMultiplier(topic) {
    // Adjust score based on target audience size
    const category = this.categorize(topic);
    const multipliers = {
      tech: 1.2,
      business: 1.1,
      education: 1.0,
      entertainment: 1.3,
      lifestyle: 1.15
    };
    
    return multipliers[category] || 1.0;
  }
}

module.exports = { ContentStrategyAgent };