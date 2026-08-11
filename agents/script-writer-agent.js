const { Logger } = require('../utils/logger');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { NIMClient } = require('../utils/nim-client');

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();

    // Llama-class model is the primary writer for original stories — stronger
    // emotional/dramatic prose than Gemini, and free. Served via the local
    // freellmapi router when configured (multi-provider failover), with
    // NVIDIA NIM direct as the fallback path inside NIMClient.
    const nvidiaKey = credentials.credentials?.nvidia?.apiKey;
    const router = credentials.credentials?.freellmapi;
    if (nvidiaKey || router?.apiKey) {
      this.nim = new NIMClient(nvidiaKey, router?.apiKey ? {
        routerUrl: (router.baseUrl || 'http://localhost:3001/v1') + '/chat/completions',
        routerKey: router.apiKey,
        routerModel: router.model || 'auto'
      } : {});
      this.logger.info(`Story LLM initialized (${router?.apiKey ? 'router + NVIDIA fallback' : 'NVIDIA direct'})`);
    } else {
      this.logger.warn('No NVIDIA/router key found — falling back to Gemini for stories');
    }

    // Gemini kept as a fallback writer and for legacy modes
    const geminiKey = credentials.credentials?.gemini?.apiKey;
    if (geminiKey) {
      const genAI = new GoogleGenerativeAI(geminiKey);
      this.gemini = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
      this.logger.info('Gemini 2.5 Flash Lite initialized as fallback');
    } else {
      this.logger.warn('Gemini API key not found - using template-based generation');
    }
  }

  // Kept for fallback template methods — always returns null so templates are used without extra quota
  async callGemini(prompt) { return null; }

  // Build the NIM prompt for a given content ANGLE. Every angle returns the
  // SAME JSON shape — { hookLine, cardText, narration, titles[] } — so the rest
  // of the pipeline (TTS, captions, intro card, video) is identical regardless
  // of format. Only the writing brief and target length change per angle.
  buildAnglePrompt(angle, premise, category, contentStyle) {
    const header = `You are the head writer for a faceless YouTube Shorts channel. The channel's content style is: ${contentStyle}.

PREMISE / TOPIC TO BUILD FROM: "${premise}"
CATEGORY: ${category}

Return ONLY valid JSON (no markdown, no code fences).`;

    const titleRules = `
TITLE RULES:
- Never start a title with "I".
- No hashtags, no emojis, no clickbait punctuation spam.
- Each title under 70 characters.`;

    // Accuracy guardrails for fact-based football angles. A football audience
    // fact-checks ruthlessly — one invented stat in the comments kills credibility.
    // (Not applied to the fictional Reddit "drama" angle.)
    const accuracy = `
ACCURACY (CRITICAL — real football fans will fact-check every claim):
- Use ONLY well-known, widely-documented facts. If you are not certain a specific number, date, scoreline, or name is correct, DO NOT state it — speak in general terms instead.
- NEVER invent statistics, recent match results, transfer news, form, or "they beat X in a friendly". You cannot verify recent events, so do not assert them as fact.
- Prefer famous, historically settled facts over precise-sounding details that might be wrong. A safe general statement beats a confident wrong number.`;

    switch (angle) {
      // ── UNEXPLAINED EVENTS COMPILATION ────────────────────────────────────
      // Modeled on the highest-multiplier shorts in this niche: stacked mini-
      // mysteries under one theme, calm documented tone, "unexplained" framing.
      case 'unexplained':
        return `${header}

{
  "hookLine": "A 5-10 word spoken opener that drops the viewer into the first mystery mid-scene, e.g. 'In 1930 an entire village vanished overnight.' Never a question, never 'here are' — start inside the first event.",
  "cardText": "A scroll-stopping question this compilation answers, e.g. 'What's the creepiest unexplained event in history?' One sentence, ends with a question mark.",
  "narration": "120-160 words of spoken prose for TTS covering 3-4 REAL documented unexplained events on this theme. Start with the exact hookLine. Each event gets 2-3 sentences: what happened (real place, real year), then the one detail that can't be explained. Move to the next event with no transition filler. Save the most unsettling event for last — or, if the theme is 'finally solved', end with the reveal. Close with exactly: 'Follow for more.'",
  "titles": [
    "An unexplained-events title, e.g. 'Unexplained Events That Made History Stop'",
    "A number-led compilation title, e.g. '4 Historical Events That Make No Sense'",
    "An emotional-promise title, e.g. 'These Unexplained Discoveries Still Give Scientists Chills'"
  ]
}

QUALITY RULES:
- 120-160 words total. Density is everything — every sentence is either a new event or the detail that makes it impossible.
- Every event must be REAL and documented: a real place, a real year, a real name where known. Never invent a mystery or exaggerate a documented one.
- If a case was later explained, either skip it or explicitly frame it as solved — do not present solved cases as ongoing mysteries.
- Calm, matter-of-fact tone. The facts are unsettling on their own — no 'scientists are baffled' hype language.
- No hashtags, no emojis.${accuracy}${titleRules}`;

      // ── FUN FACTS / TRIVIA ────────────────────────────────────────────────
      case 'facts':
        return `${header}

{
  "hookLine": "A 4-9 word spoken opener that states the single most jaw-dropping fact flat-out. It is the FIRST thing the viewer hears and sees. e.g. 'No host nation has ever lost the opener.' Make it sound impossible.",
  "cardText": "A scroll-stopping question this rundown answers, e.g. 'How much do you really know about the World Cup?' One sentence, ends with a question mark.",
  "narration": "90-140 words of punchy spoken prose for TTS. Start with the exact hookLine, then stack 3-4 surprising facts, each one wilder than the last, building to the most shocking one. Real numbers, real names, real years — never vague. End with exactly: 'Follow for more.'",
  "titles": [
    "A curiosity-gap stat title, e.g. 'The World Cup Record That Will Never Be Broken'",
    "A number-led title, e.g. '4 World Cup Facts That Sound Completely Fake'",
    "A you-reframe title, e.g. 'You Won't Believe What Happens To The World Cup Trophy'"
  ]
}

QUALITY RULES:
- 90-140 words total. Fast and dense — every sentence is a new fact or a sharper detail. No intros, no "did you know", no filler.
- Each fact must be specific and verifiable: a real year, a real number, a real name.
- Order facts so the wildest one lands last, right before the call to follow.
- No hashtags, no emojis.${accuracy}${titleRules}`;

      // ── PREDICTIONS / HOT TAKES ───────────────────────────────────────────
      case 'prediction':
        return `${header}

{
  "hookLine": "A 4-9 word spoken opener that states the bold prediction flat-out, as undeniable fact. e.g. 'An underdog wins the 2026 World Cup.' Confident, no hedging.",
  "cardText": "A debate-baiting question, e.g. 'Who's actually winning the 2026 World Cup?' One sentence, ends with a question mark.",
  "narration": "130-180 words of confident spoken prose for TTS. Start with the exact hookLine, then back the take with 2-3 sharp reasons — form, history, draw, a key player. Sound certain and a little provocative, like you're daring the viewer to disagree. End by inviting them to commit: 'Comment your pick.' or 'Tell me I'm wrong.'",
  "titles": [
    "A bold-claim title, e.g. 'The Team Nobody Is Talking About Wins It All'",
    "A number-led title, e.g. '3 Teams That Will Win The 2026 World Cup'",
    "A provocative question, e.g. 'Is This Messi's Last Ever World Cup?'"
  ]
}

QUALITY RULES:
- 130-180 words total. Opinionated and confident — pick a side and commit to it.
- Back the prediction with concrete reasoning: recent form, head-to-head history, the expanded 48-team format, a specific player.
- Stay forward-looking — this is about what WILL happen, not a history lesson.
- No hashtags, no emojis.${accuracy}${titleRules}`;

      // ── MATCH / MOMENT RECAP ──────────────────────────────────────────────
      case 'recap':
        return `${header}

{
  "hookLine": "A 4-9 word spoken opener naming the moment as something unforgettable. e.g. 'Brazil were about to be humiliated.' Drop the viewer into the tension instantly.",
  "cardText": "A nostalgic stop-scroll question, e.g. 'What's the greatest World Cup moment ever?' One sentence, ends with a question mark.",
  "narration": "180-240 words retelling this match/moment blow-by-blow, like a commentator reliving it in real time, present tense. Start with the exact hookLine, set the stakes in one line, then build minute by minute toward the iconic image everyone remembers. Real names, real scorelines, real minutes. End on the unforgettable final image — the goal, the trophy, the silence.",
  "titles": [
    "A scoreline cliffhanger, e.g. 'They Were Winning 1-0. Then Everything Collapsed.'",
    "A moment title, e.g. 'The Night A Whole Nation Went Silent'",
    "A question that reopens the wound, e.g. 'Was This The Greatest Final Ever Played?'"
  ]
}

QUALITY RULES:
- 180-240 words total. Relive it beat by beat — build tension, don't summarise it flatly.
- Use real details: the scoreline, the minute, the players, the stadium.
- End on the single iconic image, not a reflection or a lesson.
- No hashtags, no emojis.${accuracy}${titleRules}`;

      // ── REDDIT DRAMA STORY (archived theme — pre-football) ────────────────
      // The original confession-style prompt that powered the Reddit-stories
      // channel. Preserved verbatim so the theme can be restored after the
      // World Cup by setting the angle to "drama" (see archive/reddit-theme/).
      case 'drama':
        return `${header}

{
  "hookLine": "A punchy 4-8 word spoken opener that states the bombshell flat-out. This is the FIRST thing the viewer hears and sees. Examples: 'My girlfriend is a cheater.' / 'My parents are gold diggers.' / 'My best friend betrayed me.' Make it brutal and specific to THIS story.",
  "cardText": "An AskReddit-style question that this story answers, phrased to make people stop scrolling. Examples: 'What's the worst betrayal you've ever experienced?' / 'When did you realize a family member was using you?' One sentence, ends with a question mark.",
  "narration": "The full story, 250-290 words, first person, spoken prose for TTS. It MUST start with the exact hookLine, then drop straight into the action — no 'so', no 'okay so', no warm-up. Follow this beat structure so every sentence pulls the viewer forward: (1) the hook bombshell, (2) quick setup of who and what is at stake, (3) the first crack — something feels wrong, (4) the escalation — it gets worse, the stakes rise, (5) the confrontation or discovery — the shocking peak, (6) a STRONG ending where the narrator DOES something or something HAPPENS: a confrontation, a consequence, a reveal, vindication, or revenge. Conversational, like telling your best friend. Real details: ages, names, exact amounts, what was said word-for-word.",
  "titles": [
    "A cliffhanger statement that cuts off before the payoff, e.g. 'She Said She Was Working Late. Then I Saw The Receipt.'",
    "A first-person bombshell, e.g. 'My Wife's Best Friend Told Me Everything.'",
    "A question that creates an open loop, e.g. 'How Do You Forgive Someone Who Did This?'"
  ]
}

STORY QUALITY RULES:
- 250-290 words. This is roughly 2 minutes spoken — long enough for a full arc with real escalation. Reach this length by ADDING STORY BEATS (more escalation, a second twist, a vivid detail), NEVER by padding with filler, repetition, or reflection. If a sentence does not raise tension or move the story, cut it.
- RETENTION IS THE ONLY GOAL. Every sentence must make the viewer need to hear the next one. The moment the story gets predictable or slow, they swipe away.
- One clear conflict, one clear antagonist, one satisfying TURN at the end.
- THE ENDING IS EVERYTHING. Never end on the narrator blaming themselves, "questioning everything", or a reflective "I learned" wrap-up — that is boring and viewers click away. Instead END ON ACTION OR CONSEQUENCE: they confront the person, walk away with their head high, the antagonist gets caught or loses something, or a final shocking reveal lands. The viewer must finish feeling a jolt — vindication, shock, or satisfaction.
- Specific beats real. "She transferred $14,000" beats "she took money".
- No hashtags, no emojis, no Reddit jargon (AITA, NTA, OP).${titleRules}`;

      // ── DRAMATIC FOOTBALL STORY (default) ─────────────────────────────────
      default:
        return `${header}

{
  "hookLine": "A punchy 4-9 word spoken opener that states the dramatic core flat-out. This is the FIRST thing the viewer hears and sees. e.g. 'This goal cost a man his life.' / 'A 17-year-old changed football forever.' Make it gripping and specific to THIS story.",
  "cardText": "A scroll-stopping question this story answers, e.g. 'What's the most dramatic World Cup moment ever?' One sentence, ends with a question mark.",
  "narration": "The full story, 220-280 words, spoken prose for TTS. It MUST start with the exact hookLine, then drop straight into the action — no 'so', no 'okay so', no warm-up. Follow this beat structure so every sentence pulls the viewer forward: (1) the hook, (2) quick setup of who and what is at stake, (3) the first turn — the moment it starts, (4) the escalation — the stakes rise, the drama builds, (5) the peak — the unforgettable moment, (6) a STRONG ending where something LANDS: a triumph, a heartbreak, a consequence, a legacy. Tell it like you're gripping a friend by the shoulders. Real details: ages, names, scorelines, minutes, what was said.",
  "titles": [
    "A cliffhanger that cuts off before the payoff, e.g. 'He Was 17. What He Did Next Was Impossible.'",
    "A bold statement, e.g. 'The Goal That Split A Nation In Two'",
    "A question that creates an open loop, e.g. 'How Did One Moment Change Football Forever?'"
  ]
}

STORY QUALITY RULES:
- 220-280 words. Reach this length by ADDING STORY BEATS (more escalation, a vivid detail, a turn), NEVER by padding with filler or reflection. If a sentence does not raise tension or move the story, cut it.
- RETENTION IS THE ONLY GOAL. Every sentence must make the viewer need to hear the next one.
- One clear arc, real stakes, one unforgettable peak.
- THE ENDING IS EVERYTHING. Never end on a flat "and that's why he's a legend" wrap-up. END ON THE MOMENT OR ITS CONSEQUENCE — the trophy lifted, the silence, the price paid, the legacy sealed. The viewer must finish feeling a jolt.
- Specific beats vague. "In the 116th minute" beats "late in the game".
- No hashtags, no emojis, no Reddit jargon.${accuracy}${titleRules}`;
    }
  }

  // Write a complete original story from a premise using NIM (Llama 4 Maverick).
  // Returns the full package: spoken hook line, reddit-card question, narration,
  // and 3 title options. Returns null on failure so the caller can fall back.
  async generateOriginalStory(strategy) {
    const premise  = strategy.premise || strategy.topic;
    const category = strategy.category || 'drama';
    const angle    = (strategy.angle || 'story').toLowerCase();
    // Tone/style is user-configurable via config/topics.json → contentStyle.
    // Default matches the original dramatic first-person story format.
    const contentStyle = strategy.contentStyle ||
      'gripping, emotional first-person stories that feel completely real — like a true confession someone posted online';

    const prompt = this.buildAnglePrompt(angle, premise, category, contentStyle);

    try {
      const parsed = await this.nim.generateJSON(prompt, { temperature: 0.95, maxTokens: 1400 });

      if (!parsed.narration || !parsed.titles) {
        this.logger.warn('NIM returned incomplete story package');
        return null;
      }

      // Ensure the narration opens with the hook line (so TTS speaks it first)
      let narration = parsed.narration.trim();
      const hookLine = (parsed.hookLine || '').trim();
      if (hookLine && !narration.toLowerCase().startsWith(hookLine.toLowerCase().slice(0, 12))) {
        narration = `${hookLine} ${narration}`;
      }

      parsed.narration = narration;
      parsed.hook      = hookLine || narration.split('.')[0] + '.';
      parsed.hookLine  = hookLine;
      parsed.cardText  = (parsed.cardText || '').trim();
      parsed.category  = category;

      if (Array.isArray(parsed.titles) && parsed.titles.length > 0) {
        parsed.title = this.pickBestTitle(parsed.titles);
        this.logger.info(`Original story written [${category}]`);
        this.logger.info(`Hook line: "${parsed.hookLine}"`);
        this.logger.info(`Card: "${parsed.cardText}"`);
        this.logger.info(`Titles: ${parsed.titles.join(' | ')}`);
        this.logger.info(`Selected title: ${parsed.title}`);
      }

      return parsed;
    } catch (err) {
      this.logger.error('NIM original story generation failed:', err.message);
      return null;
    }
  }

  // Build the OUTLINE prompt — just the hook, chapter titles, description, and
  // title options. Deliberately does NOT ask for the full narration in this
  // call: single-shot requests for 1600-2200 words reliably undershoot (models
  // wrap up the "story" well before hitting a word-count target). We generate
  // the narration chapter-by-chapter instead — see buildLongformChapterPrompt.
  buildLongformOutlinePrompt(premise, category, contentStyle, angle = 'story') {
    // Compilation angles (e.g. 'unexplained') structure chapters as THEMED
    // GROUPS of distinct real events — ~20 events across 7 chapters — instead
    // of turning points in one chronological story. Modeled on the mega-
    // compilation format ("50 Creepy Historical Events...") that consistently
    // outperforms in this niche.
    const isCompilation = angle === 'unexplained';

    const chapterRules = isCompilation
      ? `- Exactly 7 chapters. Each chapter is a THEME grouping 3 distinct real documented events (e.g. 'Vanishings at Sea', 'Objects That Shouldn't Exist', 'Witnessed by Thousands') — the whole video covers ~20 separate events.
- Chapter themes must not overlap — every event in the video appears exactly once.
- Order chapters so the creepiest/strongest theme lands LAST.`
      : `- Exactly 7 chapters, each a real, distinct turning point in the story — not generic labels like "Introduction" or "Conclusion".
- Chapter titles must be in chronological order and specific to THIS premise.`;

    const hookRule = isCompilation
      ? `"A 6-12 word spoken opener that drops the viewer inside the single creepiest event in the whole compilation, e.g. 'In 1908 something flattened a forest the size of London.' Never 'here are 20 events' — start inside an event."`
      : `"A 6-12 word spoken opener that states the core hook flat-out — the FIRST thing the viewer hears. Must create an open loop that only watching the full video resolves."`;

    const titleExamples = isCompilation
      ? `"A numbered compilation title under 90 characters, e.g. '20 Historical Events That No One Can Explain'",
    "A no-one-can-explain title under 90 characters, e.g. 'Unexplained Events From History That Still Defy Explanation'",
    "A sounds-fake-but-true title under 90 characters, e.g. 'Historical Events That Sound Fake But Actually Happened'"`
      : `"A curiosity-gap title under 90 characters, e.g. 'The Case That Took 40 Years To Solve'",
    "A bold-statement title under 90 characters",
    "A question-format title under 90 characters"`;

    return `You are the head writer for a long-form YouTube documentary-style channel. The channel's content style is: ${contentStyle}.

PREMISE / TOPIC TO BUILD FROM: "${premise}"
CATEGORY: ${category}

Return ONLY valid JSON (no markdown, no code fences):

{
  "hookLine": ${hookRule},
  "chapters": [
    { "title": "A short chapter label", "footageQuery": "2-4 word stock-footage search term for this chapter's visuals" },
    { "title": "A second chapter label", "footageQuery": "..." },
    { "title": "A third chapter label", "footageQuery": "..." },
    { "title": "A fourth chapter label", "footageQuery": "..." },
    { "title": "A fifth chapter label", "footageQuery": "..." },
    { "title": "A sixth chapter label", "footageQuery": "..." },
    { "title": "A seventh chapter label", "footageQuery": "..." }
  ],
  "description": "A 2-3 sentence YouTube description summarising the video without spoiling the ending, written to include natural keywords for search.",
  "titles": [
    ${titleExamples}
  ]
}

RULES:
${chapterRules}
- Use ONLY well-documented, verifiable facts. Do not invent names, dates, or numbers.
- Titles: no clickbait punctuation spam, under 90 characters, no starting with "I".
- footageQuery: each is a 2-4 word Pexels stock-footage search term for that chapter's visuals. Describe SETTING, OBJECTS, weather, architecture, or environment ONLY — never a person's ethnicity, nationality, religion, gender, or any identity label (even if in the story). Use the physical scene instead: "sinking ship deck", "ocean storm night", "candlelit old documents", "iceberg cold ocean". Terms must return atmospheric B-roll, not portraits.`;
  }

  // Build the prompt for ONE chapter's narration. Generating chapter-by-chapter
  // (rather than one giant request) is what actually gets us to a real 2800+
  // word script — each call only has to hit a 400-500 word target, which models
  // reliably do, instead of a 2000+ word target, which they reliably undershoot.
  // Measured: Aoede TTS speaks at ~185-190 wpm, so 7 chapters x 400-500 words
  // (~3000-3500 words) lands at roughly 16-19 minutes — comfortably covers the
  // 10-14 minute target even if a few chapters run toward the low end.
  buildLongformChapterPrompt(premise, category, contentStyle, chapter, index, total, priorTail, angle = 'story') {
    const isCompilation = angle === 'unexplained';

    const positionNote = index === 0
      ? (isCompilation
          ? 'This is the OPENING chapter — it must start with the exact hook line and finish telling that first event before moving to the next. No "welcome" or "here are 20 events" framing, ever.'
          : 'This is the OPENING chapter — it must start with the exact hook line given below and drop straight into the story, no warm-up.')
      : index === total - 1
        ? (isCompilation
            ? 'This is the FINAL chapter — its last event should be the most unsettling in the entire video, and the video ends on the detail of that event that cannot be explained. Never a summary or sign-off.'
            : 'This is the FINAL chapter — end on the resolution, the lasting impact, or the detail that still cannot be explained. Never a flat summary or moral.')
        : (isCompilation
            ? 'This is a MIDDLE chapter — move directly into this theme\'s first event with no recap of earlier events.'
            : 'This is a MIDDLE chapter — continue directly from where the story left off, and end on a new question or escalation that pulls the viewer into the next chapter.');

    const task = isCompilation
      ? `TASK: Write 400-500 words of spoken documentary narration (for TTS) covering 3 DISTINCT real documented events that fit this chapter's theme. Each event is self-contained: where and when it happened (real place, real year), what was witnessed or found, and the one detail that has never been explained. Move between events with a single connective sentence at most. Never repeat an event from an earlier chapter.`
      : `TASK: Write 400-500 words of spoken documentary narration (for TTS) covering ONLY this chapter's part of the story. Real, verifiable detail — names, dates, numbers where documented. Do not repeat what earlier chapters already covered. Do not restate the chapter title as a heading — write flowing spoken prose only.`;

    const compilationRules = isCompilation
      ? `\n- Every event must be REAL and documented — a real place, a real year, real names where known. Never invent a mystery, never exaggerate a documented one, and never present a solved case as unsolved.
- Calm, matter-of-fact tone. The facts carry the unease — no "scientists are baffled" hype language.`
      : '';

    return `You are the head writer for a long-form YouTube documentary-style channel. The channel's content style is: ${contentStyle}.

PREMISE: "${premise}"
CATEGORY: ${category}
FULL CHAPTER LIST (in order): ${chapter.allTitles}
CURRENT CHAPTER (${index + 1} of ${total}): "${chapter.title}"
${priorTail ? `THE ${isCompilation ? 'PREVIOUS CHAPTER' : 'STORY SO FAR'} ENDED WITH: "...${priorTail}"\n` : ''}
${positionNote}

${task}

RULES:
- 400-500 words. Reach this length with real detail${isCompilation ? '' : ' and chronological depth'}, not repetition or filler.
- Use ONLY well-documented, verifiable facts. If a specific number, date, or quote is not certain, speak in general terms instead of inventing one.
- Never invent dialogue, statistics, or events that are not part of the public historical/documented record.${compilationRules}
- No hashtags, no emojis, no chapter titles or headings in the output.
- Return ONLY the narration text — no JSON, no markdown, no preamble like "Here is the narration:".`;
  }

  // Write a complete long-form documentary-style script from a premise using
  // NIM. Generates an outline first, then each chapter's narration separately,
  // then concatenates — see buildLongformChapterPrompt for why.
  async generateLongformStory(strategy) {
    const premise  = strategy.premise || strategy.topic;
    const category = strategy.category || 'Long-form';
    const angle    = (strategy.angle || 'story').toLowerCase();
    const contentStyle = strategy.contentStyle ||
      'calm, measured documentary-style narration that lays out real events chronologically with escalating tension';

    try {
      const outlinePrompt = this.buildLongformOutlinePrompt(premise, category, contentStyle, angle);
      const outline = await this.nim.generateJSON(outlinePrompt, { temperature: 0.85, maxTokens: 900, timeoutMs: 60000 });

      if (!Array.isArray(outline.chapters) || outline.chapters.length < 3 || !Array.isArray(outline.titles)) {
        this.logger.warn('NIM returned incomplete long-form outline');
        return null;
      }

      const hookLine = (outline.hookLine || '').trim();
      const allTitles = outline.chapters.map(c => c.title).join(' → ');
      const total = outline.chapters.length;
      const chapterNarrations = [];
      let priorTail = '';

      for (let i = 0; i < total; i++) {
        const chapterPrompt = this.buildLongformChapterPrompt(
          premise, category, contentStyle,
          { title: outline.chapters[i].title, allTitles }, i, total, priorTail, angle
        );
        const text = (await this.nim.generate(chapterPrompt, { temperature: 0.85, maxTokens: 900, timeoutMs: 60000 })).trim();
        chapterNarrations.push(text);
        // Record each chapter's word count so the assembler can weight its
        // footage clip's on-screen duration to its share of the narration.
        outline.chapters[i].wordCount = text.split(/\s+/).length;
        priorTail = text.split(/\s+/).slice(-40).join(' ');
        this.logger.info(`Long-form chapter ${i + 1}/${total} written — ${outline.chapters[i].wordCount} words`);
      }

      let narration = chapterNarrations.join(' ').trim();
      if (hookLine && !narration.toLowerCase().startsWith(hookLine.toLowerCase().slice(0, 12))) {
        narration = `${hookLine} ${narration}`;
      }

      const parsed = {
        narration,
        hook: hookLine || narration.split('.')[0] + '.',
        hookLine,
        cardText: '',
        category,
        chapters: outline.chapters,
        description: outline.description || '',
        titles: outline.titles
      };

      parsed.title = this.pickBestTitle(parsed.titles);
      const wordCount = narration.split(/\s+/).length;
      this.logger.info(`Long-form script complete [${category}] — ${wordCount} words across ${total} chapters`);
      this.logger.info(`Selected title: ${parsed.title}`);

      return parsed;
    } catch (err) {
      this.logger.error('NIM long-form generation failed:', err.message);
      return null;
    }
  }

  // Single call that generates the entire script package.
  async generateFullScriptWithGemini(strategy) {

    // ── LONG-FORM MODE ────────────────────────────────────────────────────────
    // Never fall through to the short-form paths below on failure — the
    // shortest of those (the generic "FACT" prompt) targets 55-65 words /
    // ~20 seconds, and silently publishing that under a long-form request
    // produced a handful of few-second "long-form" videos that went live
    // before anyone noticed. One retry (NIM timeouts here have been transient
    // rate-limit hiccups, not content errors) — if it still fails, bail out
    // and let generateScript() throw rather than degrade to the wrong format.
    if (strategy.format === 'long') {
      if (!this.nim) return null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await this.generateLongformStory(strategy);
        if (result) return result;
        this.logger.warn(`NIM long-form story failed (attempt ${attempt}/2)`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 10000));
      }
      return null;
    }

    // ── ORIGINAL STORY MODE (primary) ────────────────────────────────────────
    // Write a complete original story from a premise — the model the winning
    // channels in this niche actually use. NIM (Llama 4 Maverick) handles the
    // emotional, dark, cliffhanger tone far better than Gemini.
    if (strategy.isOriginal && this.nim) {
      const result = await this.generateOriginalStory(strategy);
      if (result) return result;
      this.logger.warn('NIM original story failed — falling back to Gemini');
      // fall through to Gemini-based generation below if NIM fails
    }

    if (!this.gemini) return null;

    // ── REDDIT STORY MODE ────────────────────────────────────────────────────
    if (strategy.fullStory) {
      const prompt = `You are rewriting a Reddit story as a YouTube Shorts narration for a brainrot gameplay channel.

Original post from r/${strategy.subreddit}:
---
${strategy.fullStory}
---

TASK:
Rewrite this as a natural, gripping first-person narration for a YouTube Short. Target 250-350 words — that is roughly 2 to 2.5 minutes of speech, which keeps it within YouTube's 3-minute Shorts limit. Do NOT exceed 380 words under any circumstances.

If the story is longer than this, distil it: keep the core conflict, the key twist or confrontation, and the resolution. Cut background padding, repeated details, and tangents. Every sentence must earn its place.

RULES:
- Open with a hook that drops the viewer straight into the conflict. No warm-up, no "so basically", no "okay so". The first sentence must create an unresolved question the viewer cannot leave without answering.
- Sound like someone telling their best friend the story — conversational, fast-paced, a little dramatic.
- Remove all Reddit formatting: no "AITA", "NTA", "YTA", "OP", "Edit:", asterisks, line breaks mid-sentence.
- Replace usernames with natural descriptions ("my coworker", "my sister", "my landlord").
- Keep real details: ages, relationships, what was said word-for-word if it matters.
- End naturally on the resolution or with "Follow for more" if it lands better.
- No filler, no moralising, no "I learned that day" wrap-ups — just the raw story.

TITLE RULES (critical):
- Cliffhanger format that creates an open loop the viewer must close.
- Never start with "I" — start with the situation or the twist.
- No hashtags, no emojis in the title.

Return ONLY valid JSON, no markdown:
{
  "titles": [
    "Title 1 — unresolved conflict (e.g. 'She Reported Me To HR For Something I Didn\\'t Do')",
    "Title 2 — outcome teaser (e.g. 'I Got My Coworker Fired. She Deserved It.')",
    "Title 3 — question format (e.g. 'Was I Wrong To Expose My Sister At Her Own Wedding?')"
  ],
  "narration": "Full word-for-word narration, complete story, conversational prose, exactly as it will be spoken by TTS.",
  "hook": "The first sentence of the narration, copied exactly from the narration field"
}`;

      try {
        const result = await this.gemini.generateContent(prompt);
        const text = result.response.text().trim()
          .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.titles) && parsed.titles.length > 0) {
          parsed.title = this.pickBestTitle(parsed.titles);
          this.logger.info(`Reddit story titles: ${parsed.titles.join(' | ')}`);
          this.logger.info(`Selected: ${parsed.title}`);
        }
        return parsed;
      } catch (error) {
        this.logger.error('Gemini Reddit script failed:', error.message);
        return null;
      }
    }

    // ── FACT / SHOCKING TOPIC MODE ───────────────────────────────────────────
    const prompt = `You are writing a 20-second English YouTube Shorts narration. Goal: stop a half-asleep scroller in the first second and keep them watching for 20 seconds.

Topic: "${strategy.topic}"

STRUCTURE:
1. HOOK (first sentence) — No warm-up, no context-setting. Drop them straight into something that makes their brain say "wait, what?" Make it personal ("your", "you") or deeply unsettling. Do NOT name the topic.
2. REVEAL — One sentence with the actual shocking fact.
3. TWIST — The angle that makes it even more jaw-dropping. A real number, real name, or unexpected consequence.
4. END — Exactly this: "Follow for more."

HARD RULES:
- 55-65 words TOTAL. That is 20 seconds. Not one word more.
- ONE idea only. No sub-points, no lists, no extra context.
- Real numbers and real names — never be vague.
- No intros: "Hey guys", "Today", "Did you know", "In this video" — all forbidden.
- Flowing conversational prose — written exactly how it will be spoken. Goes straight to text-to-speech.

HOOK EXAMPLES (match this energy):
❌ WEAK: "Did you know the human brain is a really interesting organ?"
✅ STRONG: "Your brain is lying to you right now and there's nothing you can do about it."

❌ WEAK: "Today we're going to talk about the Chernobyl disaster."
✅ STRONG: "In 1986, engineers pressed the emergency stop button on a runaway nuclear reactor — and the button itself caused the explosion."

Return ONLY valid JSON, no markdown, no code blocks:
{
  "titles": [
    "Title option 1 — curiosity gap (e.g. 'The Button That Made Chernobyl Worse')",
    "Title option 2 — shocking number or scale (e.g. '3 Seconds. 30,000x Power. 1 Button.')",
    "Title option 3 — personal/reframe (e.g. 'Your Brain Has Been Lying To You Your Entire Life')"
  ],
  "narration": "Full word-for-word narration, 55-65 words, flowing prose, exactly as it will be spoken.",
  "hook": "The first sentence of the narration, copied exactly from the narration field"
}`;

    try {
      const result = await this.gemini.generateContent(prompt);
      const text = result.response.text().trim()
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
      const parsed = JSON.parse(text);

      // Pick the best title from the 3 options
      if (Array.isArray(parsed.titles) && parsed.titles.length > 0) {
        parsed.title = this.pickBestTitle(parsed.titles);
        this.logger.info(`Title options: ${parsed.titles.join(' | ')}`);
        this.logger.info(`Selected title: ${parsed.title}`);
      }

      return parsed;
    } catch (error) {
      this.logger.error('Gemini script generation failed, using templates:', error.message, error.status || '');
      return null;
    }
  }

  pickBestTitle(titles) {
    // English curiosity-gap triggers — these stop the scroll
    const powerWords = [
      'never', 'actually', 'truth', 'real', 'secret', 'dark', 'hidden', 'exposed',
      'killed', 'destroyed', 'impossible', 'insane', 'shocking', 'banned', 'deadly',
      'why', 'how', 'what', 'worst', 'dangerous', 'terrifying', 'disturbing'
    ];

    const scored = titles.map(title => {
      let score = 0;
      const lower = title.toLowerCase();

      // Hard penalty for hashtags — never allowed in title
      if (title.includes('#')) score -= 20;

      // Strongly reward LEADING numbers — the listicle format.
      // Measured on this channel (Aug 2026, videos published inside the same
      // distribution window): titles starting with a number returned a median
      // 657 views vs 262 for everything else, n=11 vs 9. Cleanest single
      // comparison: "3 Baffling Places" (972) vs "What Happens To Your Skin"
      // (2), published 37 minutes apart the same night.
      // Only fires when the angle actually offered a listicle candidate, so
      // single-narrative angles are unaffected.
      if (/^\s*\d+\b/.test(title)) score += 10;
      else if (/\d/.test(title)) score += 4;   // a number elsewhere still helps

      // Reward power words
      powerWords.forEach(w => { if (lower.includes(w)) score += 2; });

      // Reward curiosity gap patterns ("The X That Did Y", "Why X Actually...")
      if (/\bthe\b.+\bthat\b|\bwhy\b|\bhow\b|\bwhat\b/i.test(title)) score += 3;

      // Reward question marks (open loop = watch to find out)
      if (title.includes('?')) score += 3;

      // Penalise if too long (title gets cut off in feed)
      if (title.length > 60) score -= 3;
      if (title.length < 15) score -= 2;

      return { title, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Strip any stray hashtags just in case
    return scored[0].title.replace(/#\S+/g, '').trim();
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    return true;
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'question', 'background', 'explanation', 'examples', 'implications', 'summary', 'cta'],
        tone: 'informative',
        pacing: 'steady'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'journey', 'climax', 'resolution', 'lesson', 'cta'],
        tone: 'narrative',
        pacing: 'dynamic'
      }
    };
  }

  async generateScript(strategy) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);

      const template = this.templates[strategy.contentType.toLowerCase()] || this.templates.explainer;

      // Try single Gemini call first (uses only 1 of 20 daily quota)
      const ai = await this.generateFullScriptWithGemini(strategy);

      // Long-form has no template fallback — the templates below produce
      // ~60-word placeholder content meant for a completely different format,
      // and silently publishing that under a long-form request already
      // shipped a batch of broken few-second "long-form" videos once. If NIM
      // couldn't write a long-form script after retries, fail loudly instead.
      if (!ai && strategy.format === 'long') {
        throw new Error('Long-form script generation failed after retries — aborting rather than publishing a short-form fallback under a long-form request.');
      }

      let hook, introduction, mainContent, conclusion, cta, title;

      if (ai) {
        this.logger.info('Full script package generated successfully');
        title = ai.title;
        hook = { type: 'ai', text: ai.hook || ai.narration.split('.')[0] + '.', duration: '0:00-0:05' };
        // Keep these empty — the narration field is the single source of truth for TTS
        introduction = { greeting: '', topicIntro: '', valueProposition: '', credibility: '', duration: '0:05-0:20' };
        mainContent = {
          sections: [{ type: 'ai_generated', content: ai.narration }],
          totalDuration: '0:00-1:00'
        };
        conclusion = { type: 'conclusion', finalThought: '', duration: '0 seconds' };
        cta = { type: 'call_to_action', subscribe: '', like: '', comment: '', nextVideo: '', duration: '0 seconds' };
      } else {
        // Fallback to templates
        title = await this.generateTitle(strategy);
        hook = await this.generateHook(strategy);
        introduction = await this.generateIntroduction(strategy);
        mainContent = await this.generateMainContent(strategy, template);
        conclusion = await this.generateConclusion(strategy);
        cta = await this.generateCTA(strategy);
      }

      // Assemble complete script
      const script = {
        title,
        hook,
        introduction,
        mainContent,
        conclusion,
        callToAction: cta,
        // Clean narration field — this is the single source of truth for TTS.
        // If Gemini generated it, use it directly. Otherwise derive from sections.
        narration: ai?.narration || null,
        // Original-story extras — used by video overlay (Phase 2) + description
        hookLine: ai?.hookLine || null,
        cardText: ai?.cardText || null,
        category: ai?.category || strategy.category || null,
        // Long-form extras — chapters/description for the YouTube upload
        chapters: ai?.chapters || [],
        longformDescription: ai?.description || null,
        format: strategy.format || 'short',
        duration: this.estimateDuration(mainContent),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords,
        metadata: {
          strategy: strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      // Format for readability
      script.fullScript = this.formatFullScript(script);
      
      // Save to database
      await this.db.saveScript(script);
      
      this.logger.info(`Script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate script:', error);
      throw error;
    }
  }

  async generateTitle(strategy) {
    const aiTitle = await this.callGemini(
      `Generate a single viral YouTube video title for a video about "${strategy.topic}".
       Content type: ${strategy.contentType}. Target audience: general audience of all ages interested in viral, trending, and entertaining content.
       The title must be attention-grabbing, under 70 characters, and optimized for clicks.
       Return ONLY the title text, no quotes, no explanation.`
    );
    if (aiTitle) return aiTitle;

    if (strategy.contentType === 'Tutorial') return `How to ${strategy.topic}: Step-by-Step Guide`;
    if (strategy.contentType === 'List') return `Top 10 ${strategy.topic} Tips You Need to Know`;
    if (strategy.contentType === 'Review') return `${strategy.topic} Review: Is It Worth It?`;
    return `The Truth About ${strategy.topic} (Shocking Results)`;
  }

  async generateHook(strategy) {
    const aiHook = await this.callGemini(
      `Write a 1-2 sentence viral YouTube video hook for a video about "${strategy.topic}".
       It must grab attention in the first 5 seconds and make viewers unable to stop watching.
       Return ONLY the hook text, no quotes, no explanation.`
    );

    return {
      type: 'ai',
      text: aiHook || `Most people have no idea what's really going on with ${strategy.topic} — until now.`,
      duration: '0:00-0:05'
    };
  }

  generateQuestionAbout(topic) {
    const questions = [
      `why ${topic} is becoming so important`,
      `how ${topic} actually works`,
      `what makes ${topic} different from everything else`,
      `why experts are talking about ${topic}`,
      `how ${topic} could change your life`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateStatistic(topic) {
    const stats = [
      `90% of people don't understand ${topic} correctly`,
      `${topic} has grown by 300% in the last year alone`,
      `experts predict ${topic} will be worth billions by 2030`,
      `only 1 in 10 people are using ${topic} effectively`,
      `${topic} can save you hours every single day`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  async generateIntroduction(strategy) {
    const aiIntro = await this.callGemini(
      `Write a 3-4 sentence YouTube video introduction for a video about "${strategy.topic}".
       Channel style: viral, entertaining, all ages. Be energetic and engaging.
       Return ONLY the introduction text, no labels or explanation.`
    );
    const introText = aiIntro || `Hey everyone, welcome back! Today we're diving into ${strategy.topic} and you're NOT going to believe what we found.`;
    return {
      greeting: introText,
      topicIntro: `Today's topic: ${strategy.topic}.`,
      valueProposition: `By the end, you'll know exactly why everyone is talking about this.`,
      credibility: 'Based on the latest trending data.',
      duration: '0:05-0:20'
    };
  }

  getValueProposition(strategy) {
    const propositions = {
      'Tutorial': `how to implement ${strategy.topic} step by step`,
      'Explainer': `what ${strategy.topic} is and why it matters`,
      'List': `the most important things about ${strategy.topic}`,
      'Review': `whether ${strategy.topic} is right for you`,
      'Story': `the incredible journey of ${strategy.topic}`
    };
    
    return propositions[strategy.contentType] || `everything about ${strategy.topic}`;
  }

  getCredibilityStatement(strategy) {
    const statements = [
      "I've spent months researching this topic",
      "After working with hundreds of people on this",
      "Based on the latest research and data",
      "Drawing from real-world experience",
      "Using proven methods and strategies"
    ];
    
    return statements[Math.floor(Math.random() * statements.length)];
  }

  async generateMainContent(strategy, template) {
    const aiBody = await this.callGemini(
      `Write the full main body script for a YouTube video about "${strategy.topic}".
       Content type: ${strategy.contentType}. Channel: a viral, trending, entertaining channel for all ages.
       Structure it with 3-5 clear sections. Each section should have a bold heading and 2-4 engaging sentences.
       Keep total length suitable for a 5-8 minute video. Write in a conversational, energetic tone.
       Return ONLY the script body text with section headings, no extra explanation.`
    );

    if (aiBody) {
      return {
        sections: [{ type: 'ai_generated', content: aiBody }],
        totalDuration: '1:00-7:00'
      };
    }

    const sections = [];
    for (const section of template.structure) {
      if (!['hook', 'introduction', 'cta'].includes(section)) {
        sections.push(await this.generateSection(section, strategy));
      }
    }
    return { sections, totalDuration: this.calculateSectionsDuration(sections) };
  }

  async generateSection(sectionType, strategy) {
    const sectionGenerators = {
      problem: () => this.generateProblemSection(strategy),
      solution_steps: () => this.generateSolutionSteps(strategy),
      demonstration: () => this.generateDemonstration(strategy),
      explanation: () => this.generateExplanation(strategy),
      examples: () => this.generateExamples(strategy),
      list_items: () => this.generateListItems(strategy),
      pros: () => this.generatePros(strategy),
      cons: () => this.generateCons(strategy),
      comparison: () => this.generateComparison(strategy),
      implications: () => this.generateImplications(strategy)
    };

    const generator = sectionGenerators[sectionType];
    
    if (generator) {
      return await generator();
    }
    
    return this.generateGenericSection(sectionType, strategy);
  }

  async generateProblemSection(strategy) {
    return {
      type: 'problem',
      title: 'The Challenge',
      content: [
        `Many people struggle with ${strategy.topic}.`,
        `The main issues are:`,
        `1. Lack of clear information`,
        `2. Complexity and confusion`,
        `3. Not knowing where to start`,
        `But don't worry, we're going to solve all of these today.`
      ],
      visuals: ['Problem illustration', 'Statistics graphic'],
      duration: 30
    };
  }

  async generateSolutionSteps(strategy) {
    const steps = [];
    const numSteps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
    
    for (let i = 1; i <= numSteps; i++) {
      steps.push({
        number: i,
        title: `Step ${i}: ${this.generateStepTitle(strategy.topic, i)}`,
        description: this.generateStepDescription(strategy.topic, i),
        tip: this.generateProTip(strategy.topic)
      });
    }
    
    return {
      type: 'solution_steps',
      title: 'The Solution',
      steps,
      duration: steps.length * 45
    };
  }

  generateStepTitle(topic, stepNumber) {
    const titles = [
      'Research and Preparation',
      'Setting Up the Foundation',
      'Implementation and Execution',
      'Testing and Optimization',
      'Scaling and Automation'
    ];
    
    return titles[stepNumber - 1] || `Advanced ${topic} Techniques`;
  }

  generateStepDescription(topic, stepNumber) {
    return `This step involves understanding the key aspects of ${topic} and how to apply them effectively. Pay special attention to the details here, as they make all the difference.`;
  }

  generateProTip(topic) {
    const tips = [
      `Pro tip: Start small and scale gradually`,
      `Remember: Consistency is more important than perfection`,
      `Quick tip: Document everything as you go`,
      `Expert advice: Focus on one aspect at a time`,
      `Insider secret: This works best when combined with regular practice`
    ];
    
    return tips[Math.floor(Math.random() * tips.length)];
  }

  async generateDemonstration(strategy) {
    return {
      type: 'demonstration',
      title: 'Live Demo',
      content: [
        `Now let me show you exactly how this works.`,
        `[Screen recording or visual demonstration]`,
        `As you can see, the process is straightforward once you understand the basics.`,
        `The key is to follow the steps exactly as shown.`
      ],
      visuals: ['Screen recording', 'Step-by-step graphics'],
      duration: 120
    };
  }

  async generateExplanation(strategy) {
    return {
      type: 'explanation',
      title: 'Deep Dive',
      content: [
        `Let's break down ${strategy.topic} into its core components.`,
        `First, we need to understand the fundamental principles.`,
        `The science behind this is fascinating...`,
        `[Detailed explanation with visuals]`,
        `This is why ${strategy.topic} works so effectively.`
      ],
      visuals: ['Diagrams', 'Infographics', 'Charts'],
      duration: 90
    };
  }

  async generateExamples(strategy) {
    return {
      type: 'examples',
      title: 'Real-World Examples',
      content: [
        `Let's look at some real examples of ${strategy.topic} in action.`,
        `Example 1: [Specific case study]`,
        `Example 2: [Another relevant example]`,
        `Example 3: [Third compelling example]`,
        `These examples show the versatility and power of ${strategy.topic}.`
      ],
      visuals: ['Case study graphics', 'Before/after comparisons'],
      duration: 75
    };
  }

  async generateListItems(strategy) {
    const items = [];
    const numItems = 5 + Math.floor(Math.random() * 6); // 5-10 items
    
    for (let i = 1; i <= numItems; i++) {
      items.push({
        number: numItems - i + 1, // Countdown for engagement
        title: this.generateListItemTitle(strategy.topic, i),
        description: this.generateListItemDescription(strategy.topic),
        impact: this.generateImpactStatement()
      });
    }
    
    return {
      type: 'list_items',
      title: `Top ${numItems} Things About ${strategy.topic}`,
      items,
      duration: items.length * 30
    };
  }

  generateListItemTitle(topic, index) {
    const titles = [
      `The Hidden Power of ${topic}`,
      `Why ${topic} Matters More Than You Think`,
      `The Surprising Truth About ${topic}`,
      `How ${topic} Can Transform Your Approach`,
      `The ${topic} Secret Nobody Talks About`,
      `Mastering ${topic} in Record Time`,
      `The Ultimate ${topic} Hack`,
      `${topic}: The Game Changer`,
      `Breaking Down ${topic} Myths`,
      `The Future of ${topic}`
    ];
    
    return titles[index - 1] || `Advanced ${topic} Technique #${index}`;
  }

  generateListItemDescription(topic) {
    return `This aspect of ${topic} is crucial because it fundamentally changes how we approach the subject. Understanding this will give you a significant advantage.`;
  }

  generateImpactStatement() {
    const impacts = [
      'This alone can save you hours',
      'Game-changing for beginners',
      'Essential for long-term success',
      'Often overlooked but critical',
      'The difference between success and failure'
    ];
    
    return impacts[Math.floor(Math.random() * impacts.length)];
  }

  async generatePros(strategy) {
    return {
      type: 'pros',
      title: 'The Benefits',
      points: [
        'Easy to get started',
        'Cost-effective solution',
        'Proven results',
        'Scalable approach',
        'Community support'
      ],
      duration: 45
    };
  }

  async generateCons(strategy) {
    return {
      type: 'cons',
      title: 'Things to Consider',
      points: [
        'Learning curve at the beginning',
        'Requires consistent effort',
        'Results may vary',
        'Some technical knowledge helpful'
      ],
      duration: 30
    };
  }

  async generateComparison(strategy) {
    return {
      type: 'comparison',
      title: 'How It Compares',
      content: `Compared to alternatives, ${strategy.topic} stands out because of its unique approach and proven effectiveness.`,
      comparisonPoints: [
        'More efficient than traditional methods',
        'Better ROI than competitors',
        'Easier to implement',
        'More sustainable long-term'
      ],
      duration: 60
    };
  }

  async generateImplications(strategy) {
    return {
      type: 'implications',
      title: 'What This Means',
      content: [
        `The implications of ${strategy.topic} are far-reaching.`,
        'This will change how we think about the industry.',
        'Early adopters will have a significant advantage.',
        'The potential for growth is enormous.'
      ],
      duration: 45
    };
  }

  generateGenericSection(sectionType, strategy) {
    return {
      type: sectionType,
      title: sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      content: `This section covers important aspects of ${strategy.topic} that you need to know.`,
      duration: 60
    };
  }

  async generateConclusion(strategy) {
    const aiConclusion = await this.callGemini(
      `Write a 2-3 sentence conclusion for a YouTube video about "${strategy.topic}".
       End on a high note that leaves viewers wanting more. Return ONLY the conclusion text.`
    );
    return {
      type: 'conclusion',
      title: 'Wrapping Up',
      finalThought: aiConclusion || `That's a wrap on ${strategy.topic} — absolutely wild, right? Drop your reaction in the comments!`,
      duration: '30 seconds'
    };
  }

  async generateCTA(strategy) {
    return {
      type: 'call_to_action',
      subscribe: "If this blew your mind, smash that subscribe button and ring the bell so you never miss a new video!",
      like: "Tap the like button if this video shocked you.",
      comment: `Comment below: Did you already know about ${strategy.topic}? Let's see who's in the know!`,
      nextVideo: "Check out our next video — you won't believe what we found.",
      duration: '15 seconds'
    };
  }

  formatFullScript(script) {
    let fullScript = '';
    
    // Title
    fullScript += `TITLE: ${script.title}\n\n`;
    fullScript += '═'.repeat(50) + '\n\n';
    
    // Hook
    fullScript += `[${script.hook.duration}] HOOK\n`;
    fullScript += `${script.hook.text}\n\n`;
    
    // Introduction
    fullScript += `[${script.introduction.duration}] INTRODUCTION\n`;
    fullScript += `${script.introduction.greeting}\n`;
    fullScript += `${script.introduction.topicIntro}\n`;
    fullScript += `${script.introduction.valueProposition}\n`;
    fullScript += `${script.introduction.credibility}\n\n`;
    
    // Main Content
    fullScript += 'MAIN CONTENT\n';
    fullScript += '─'.repeat(30) + '\n\n';
    
    for (const section of script.mainContent.sections) {
      if (section.title) fullScript += `[${this.formatDuration(section.duration)}] ${section.title.toUpperCase()}\n`;

      if (Array.isArray(section.content)) {
        section.content.forEach(line => { fullScript += `${line}\n`; });
      } else if (typeof section.content === 'string') {
        fullScript += `${section.content}\n`;
      } else if (section.steps) {
        section.steps.forEach(step => {
          fullScript += `\n${step.title}\n${step.description}\n💡 ${step.tip}\n`;
        });
      } else if (section.items) {
        section.items.forEach(item => {
          fullScript += `\n#${item.number}: ${item.title}\n${item.description}\nImpact: ${item.impact}\n`;
        });
      } else if (section.points) {
        section.points.forEach(point => { fullScript += `• ${point}\n`; });
      }

      if (section.visuals) fullScript += `\n[VISUALS: ${section.visuals.join(', ')}]\n`;
      fullScript += '\n';
    }

    // Conclusion
    fullScript += `[${script.conclusion.duration || '30s'}] CONCLUSION\n`;
    if (Array.isArray(script.conclusion.recap)) {
      script.conclusion.recap.forEach(line => { fullScript += `${line}\n`; });
    }
    fullScript += `\n${script.conclusion.finalThought || ''}\n\n`;
    
    // Call to Action
    fullScript += `[${script.callToAction.duration}] CALL TO ACTION\n`;
    fullScript += `${script.callToAction.subscribe}\n`;
    fullScript += `${script.callToAction.like}\n`;
    fullScript += `${script.callToAction.comment}\n`;
    fullScript += `${script.callToAction.nextVideo}\n\n`;
    
    // Metadata
    fullScript += '═'.repeat(50) + '\n';
    fullScript += `ESTIMATED DURATION: ${script.duration}\n`;
    fullScript += `TONE: ${script.tone}\n`;
    fullScript += `PACING: ${script.pacing}\n`;
    fullScript += `KEYWORDS: ${(script.keywords || []).join(', ')}\n`;
    
    return fullScript;
  }

  estimateDuration(mainContent) {
    const totalSeconds = mainContent.sections.reduce((total, section) => {
      return total + (section.duration || 60);
    }, 0);
    
    // Add hook, intro, conclusion, CTA
    const fullDuration = totalSeconds + 5 + 15 + 30 + 15;
    
    return this.formatDuration(fullDuration);
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  calculateSectionsDuration(sections) {
    return sections.reduce((total, section) => total + (section.duration || 60), 0);
  }
}

module.exports = { ScriptWriterAgent };