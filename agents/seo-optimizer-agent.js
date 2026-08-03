const { Logger } = require('../utils/logger');

class SEOOptimizerAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('SEOOptimizer');
    this.keywordDatabase = new Map();
  }

  async initialize() {
    this.logger.info('Initializing SEO Optimizer Agent...');
    await this.loadKeywordDatabase();
    return true;
  }

  async loadKeywordDatabase() {
    try {
      const keywords = await this.db.getKeywordHistory();
      keywords.forEach(kw => {
        this.keywordDatabase.set(kw.keyword, kw.performance);
      });
    } catch (error) {
      this.logger.warn('No keyword history found');
    }
  }

  async optimize(script, strategy) {
    try {
      this.logger.info(`Optimizing SEO for: ${script.title}`);
      
      // Generate optimized title
      const title = await this.optimizeTitle(script.title, strategy);
      
      // Generate description
      const description = await this.generateDescription(script, strategy);
      
      // Extract and optimize tags
      const tags = await this.generateTags(script, strategy);
      
      // Generate hashtags
      const hashtags = await this.generateHashtags(strategy);
      
      // Create chapters/timestamps
      const chapters = await this.generateChapters(script);
      
      // Generate end screen elements
      const endScreen = await this.generateEndScreenStrategy();
      
      // Calculate SEO score
      const seoScore = await this.calculateSEOScore(title, description, tags);
      
      const seoData = {
        title,
        description,
        tags,
        hashtags,
        chapters,
        endScreen,
        seoScore,
        metadata: {
          primaryKeyword: strategy.keywords[0],
          secondaryKeywords: strategy.keywords.slice(1, 5),
          targetLength: this.calculateOptimalLength(strategy.contentType),
          language: 'en',
          category: this.selectCategory(strategy)
        },
        createdAt: new Date().toISOString()
      };
      
      // Save to database
      await this.db.saveSEOData(seoData);
      
      this.logger.info(`SEO optimization complete. Score: ${seoScore}/100`);
      return seoData;
    } catch (error) {
      this.logger.error('Failed to optimize SEO:', error);
      throw error;
    }
  }

  async optimizeTitle(originalTitle, strategy) {
    // Strip any hashtags — hashtags in titles kill CTR and look spammy.
    // They belong in the description only.
    let optimizedTitle = originalTitle.replace(/#\S+/g, '').trim();

    // Remove stale filler appended by older logic (year brackets, keyword dash-appends)
    // so the AI-generated curiosity-gap title stays clean and punchy.

    // Hard truncate at 100 chars (YouTube limit) — prefer clean cut at word boundary
    if (optimizedTitle.length > 100) {
      optimizedTitle = optimizedTitle.substring(0, 97).replace(/\s+\S*$/, '') + '...';
    }

    return optimizedTitle;
  }

  titleCase(str) {
    const smallWords = ['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in', 'of', 'on', 'or', 'the', 'to', 'via', 'vs'];
    
    return str.split(' ').map((word, index) => {
      if (index === 0 || !smallWords.includes(word.toLowerCase())) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word.toLowerCase();
    }).join(' ');
  }

  async generateDescription(script, strategy) {
    const hashtags = await this.generateHashtags(strategy);
    const hashtagLine = hashtags.slice(0, 5).join(' ');

    // hook may be a string or an object — extract plain text
    const hookText = typeof script.hook === 'string'
      ? script.hook
      : (script.hook?.text || script.hook?.opening || script.title);

    // Long-form: real, verifiable stories (true crime/history) — a longer,
    // keyword-rich description with chapters. No "names changed" disclaimer,
    // since these are documented real events, not anonymized confessions.
    if (strategy.format === 'long') {
      const chapterLines = (script.chapters || [])
        .map((c, i) => `${i + 1}. ${c.title}`)
        .join('\n');
      return [
        script.longformDescription || hookText,
        '',
        chapterLines,
        '',
        hashtagLine
      ].filter(Boolean).join('\n');
    }

    // Shorts description stays minimal: hook + follow CTA + hashtags.
    // (The old Reddit-era "no part 2" / anonymity lines don't fit a facts channel.)
    const description = [
      hookText,
      '',
      'Follow for more — a new one every day. 👇',
      '',
      hashtagLine
    ].join('\n');

    return description;
  }

  async generateTags(script, strategy) {
    // Tags are split into 3 buckets — YouTube uses these to understand context
    // and route the video to the right audience.

    // ── BUCKET 1: Post-specific (3-4 tags) ──────────────────────────────
    // Describe exactly what THIS video is about. Think: what would someone
    // type into YouTube search if they wanted this exact video?
    const topic = strategy.topic.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const topicWords = topic.split(/\s+/).filter(w => w.length > 2);

    const postSpecific = new Set();
    postSpecific.add(topic);
    if (topicWords.length > 1) postSpecific.add(topicWords[0]);
    if (strategy.keywords?.[0]) postSpecific.add(strategy.keywords[0].toLowerCase());
    if (strategy.keywords?.[1]) postSpecific.add(strategy.keywords[1].toLowerCase());
    const postTags = [...postSpecific].slice(0, 4);

    // ── BUCKET 2: Niche-specific (5-6 tags) ─────────────────────────────
    // Read from config/topics.json (seoTags.niche) so tags always track the
    // channel's actual niche; fall back to facts/mystery defaults.
    let nicheTags = [
      'history facts',
      'unexplained mysteries',
      'true stories',
      'mind blowing facts',
      'documented mysteries',
      'historical events'
    ];
    let broadTags = [
      'shorts',
      'viral shorts',
      'did you know',
      'facts'
    ];
    try {
      const p = require('path').join(__dirname, '..', 'config',
        strategy.format === 'long' ? 'topics-longform.json' : 'topics.json');
      delete require.cache[require.resolve(p)];
      const cfg = require(p);
      if (Array.isArray(cfg.seoTags?.niche) && cfg.seoTags.niche.length) nicheTags = cfg.seoTags.niche;
      if (Array.isArray(cfg.seoTags?.broad) && cfg.seoTags.broad.length) broadTags = cfg.seoTags.broad;
    } catch (_) { /* config optional — defaults above match the current channel */ }

    // Merge: post-specific first (most signal), then niche, then broad
    const allTags = [...postTags, ...nicheTags, ...broadTags];

    // Deduplicate and enforce YouTube's 500-char total limit
    const seen = new Set();
    let charCount = 0;
    const finalTags = [];
    for (const tag of allTags) {
      const t = tag.trim();
      if (!t || seen.has(t)) continue;
      if (charCount + t.length + 1 > 500) break;
      seen.add(t);
      finalTags.push(t);
      charCount += t.length + 1;
    }

    return finalTags;
  }

  identifyNiche(strategy) {
    const topic = strategy.topic.toLowerCase();
    
    const niches = {
      'technology': ['tech', 'software', 'hardware', 'gadget', 'computer', 'phone', 'app'],
      'gaming': ['game', 'gaming', 'gamer', 'play', 'stream'],
      'education': ['learn', 'study', 'course', 'tutorial', 'education', 'teach'],
      'business': ['business', 'entrepreneur', 'startup', 'money', 'finance', 'invest'],
      'lifestyle': ['life', 'lifestyle', 'daily', 'routine', 'habit'],
      'health': ['health', 'fitness', 'workout', 'diet', 'nutrition', 'wellness'],
      'entertainment': ['fun', 'comedy', 'entertainment', 'funny', 'laugh']
    };
    
    for (const [niche, keywords] of Object.entries(niches)) {
      if (keywords.some(keyword => topic.includes(keyword))) {
        return niche;
      }
    }
    
    return 'general';
  }

  getNicheTags(niche) {
    const nicheTags = {
      'technology': ['tech', 'technology', 'innovation', 'future tech', 'tech news'],
      'gaming': ['gaming', 'gameplay', 'walkthrough', 'lets play', 'game review'],
      'education': ['educational', 'learning', 'study tips', 'online learning', 'edtech'],
      'business': ['business tips', 'entrepreneurship', 'startup', 'business strategy', 'success'],
      'lifestyle': ['lifestyle', 'life hacks', 'daily routine', 'productivity', 'self improvement'],
      'health': ['health tips', 'fitness', 'healthy living', 'wellness', 'nutrition'],
      'entertainment': ['entertainment', 'fun', 'viral', 'trending', 'must watch'],
      'general': ['video', 'youtube', 'content', 'new', 'latest']
    };
    
    return nicheTags[niche] || nicheTags.general;
  }

  generateLongTailKeywords(strategy) {
    const longTailTemplates = [
      `how to ${strategy.topic}`,
      `${strategy.topic} for beginners`,
      `${strategy.topic} tutorial`,
      `best ${strategy.topic}`,
      `${strategy.topic} tips and tricks`,
      `${strategy.topic} step by step`,
      `${strategy.topic} guide ${new Date().getFullYear()}`,
      `${strategy.topic} explained simply`,
      `everything about ${strategy.topic}`,
      `${strategy.topic} mistakes to avoid`
    ];
    
    return longTailTemplates.slice(0, 5);
  }

  prioritizeTags(tags, strategy) {
    // Score and sort tags by importance
    const scoredTags = tags.map(tag => {
      let score = 0;
      
      // Primary keyword gets highest score
      if (tag === strategy.keywords[0]) score += 10;
      
      // Other strategy keywords
      if (strategy.keywords.includes(tag)) score += 5;
      
      // Contains topic
      if (tag.includes(strategy.topic.toLowerCase())) score += 3;
      
      // Long-tail keywords
      if (tag.split(' ').length > 2) score += 2;
      
      // Current year
      if (tag.includes(new Date().getFullYear().toString())) score += 1;
      
      return { tag, score };
    });
    
    // Sort by score descending
    scoredTags.sort((a, b) => b.score - a.score);
    
    return scoredTags.map(item => item.tag);
  }

  async generateHashtags(strategy) {
    // Hashtags are fully controlled — no keyword extraction.
    // Keyword-based tags were producing wrong results (e.g. #gta on a landlord story)
    // because strategy.keywords can be contaminated by trends data or prior runs.
    const isLong = strategy.format === 'long';

    // --- Core tags (always included) — #Shorts only makes sense on Shorts;
    //     tagging a 16:9 long-form video #Shorts actively misleads YouTube's classifier. ---
    const coreTags = isLong
      ? ['#documentary', '#realstory']
      : ['#Shorts', '#viral', '#trending', '#fyp', '#foryou'];

    // --- Niche tags: prefer user config (config/topics.json or
    //     config/topics-longform.json → "hashtags"), else fall back to a
    //     format-appropriate default set. Keeps niche tags accurate when the
    //     channel switches topics or formats. ---
    let nicheTags = isLong
      ? ['#truecrime', '#truestory', '#darkhistory', '#mystery']
      : ['#reddit', '#aita', '#redditstories', '#redditdrama',
         '#storytime', '#relationship', '#pettyrevenge', '#truestory'];
    try {
      const p = require('path').join(__dirname, '..', 'config', isLong ? 'topics-longform.json' : 'topics.json');
      const fs = require('fs');
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(cfg.hashtags) && cfg.hashtags.length) {
          nicheTags = cfg.hashtags
            .map(t => (t.startsWith('#') ? t : `#${t}`))
            .slice(0, 10);
        }
      }
    } catch (_) { /* fall back to default niche tags */ }

    // Combine all — order matters for YouTube: most important first
    return [
      ...coreTags,
      ...nicheTags
    ];
  }

  async generateChapters(script) {
    const chapters = [];
    let currentTime = 0;
    
    // Introduction
    chapters.push({
      time: '00:00',
      title: 'Introduction',
      seconds: 0
    });
    
    currentTime = 20; // Intro duration
    
    // Main content chapters
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        const minutes = Math.floor(currentTime / 60);
        const seconds = currentTime % 60;
        const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        chapters.push({
          time: timeString,
          title: section.title || 'Section',
          seconds: currentTime
        });
        
        currentTime += section.duration || 60;
      });
    }
    
    // Conclusion
    const conclusionMinutes = Math.floor(currentTime / 60);
    const conclusionSeconds = currentTime % 60;
    chapters.push({
      time: `${conclusionMinutes.toString().padStart(2, '0')}:${conclusionSeconds.toString().padStart(2, '0')}`,
      title: 'Conclusion & Next Steps',
      seconds: currentTime
    });
    
    return chapters;
  }

  async generateEndScreenStrategy() {
    return {
      elements: [
        {
          type: 'video',
          position: 'left',
          title: 'Recommended Video',
          duration: 20
        },
        {
          type: 'playlist',
          position: 'right',
          title: 'Watch More',
          duration: 20
        },
        {
          type: 'subscribe',
          position: 'center-bottom',
          duration: 20
        }
      ],
      startTime: -20, // 20 seconds before end
      template: 'standard'
    };
  }

  async calculateSEOScore(title, description, tags) {
    // Scoring calibrated for YouTube Shorts + Reddit story format.
    // Long-form metrics (timestamps, 500-word descriptions, links) don't apply here.
    let score = 0;

    // ── Title (35 pts) ───────────────────────────────────────────────────
    // Shorts titles: punchy, 40-70 chars, curiosity-gap, no hashtags
    if (title.length >= 40 && title.length <= 70) score += 15;
    else if (title.length >= 30 && title.length <= 100) score += 8;

    if (!/#+\S/.test(title)) score += 5;   // No hashtags in title
    if (/[A-Z]/.test(title)) score += 5;   // Proper capitalisation

    // Curiosity-gap / drama triggers
    const hookWords = ['did', 'would', 'she', 'he', 'they', 'why', 'how', 'what',
      'my', 'told', 'caught', 'found', 'refused', 'secret', 'exposed'];
    if (hookWords.some(w => title.toLowerCase().split(' ')[0] === w ||
        title.toLowerCase().startsWith(w + ' '))) score += 10;

    // ── Description (30 pts) ─────────────────────────────────────────────
    // Shorts descriptions should be short: hook + CTA + hashtags only
    if (description.length >= 50) score += 10;   // Has actual content
    if (description.includes('#')) score += 10;   // Has hashtags
    if (description.toLowerCase().includes('follow')) score += 10;  // Has CTA

    // ── Tags (35 pts) ────────────────────────────────────────────────────
    if (tags.length >= 8) score += 10;
    if (tags.length >= 12) score += 5;
    if (tags.some(t => ['reddit stories', 'aita', 'reddit shorts'].includes(t))) score += 10; // Niche tags present
    if (tags.join('').length <= 500) score += 5;           // Within YouTube limit
    if (new Set(tags).size === tags.length) score += 5;    // No duplicates

    return Math.min(100, score);
  }

  calculateOptimalLength(contentType) {
    const optimalLengths = {
      'Tutorial': '10-15 minutes',
      'Explainer': '5-10 minutes',
      'Review': '8-12 minutes',
      'List': '8-15 minutes',
      'Story': '10-20 minutes'
    };
    
    return optimalLengths[contentType] || '8-12 minutes';
  }

  selectCategory(strategy) {
    const categories = {
      'technology': 28, // Science & Technology
      'gaming': 20, // Gaming
      'education': 27, // Education
      'business': 27, // Education (closest match)
      'lifestyle': 22, // People & Blogs
      'health': 26, // Howto & Style
      'entertainment': 24 // Entertainment
    };
    
    const niche = this.identifyNiche(strategy);
    return categories[niche] || 22; // Default to People & Blogs
  }
}

module.exports = { SEOOptimizerAgent };