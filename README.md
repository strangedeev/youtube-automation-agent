# YouTube Automation Agent

An end-to-end pipeline that researches a topic, writes a script, narrates it, sources matching
footage, burns in captions, and publishes to YouTube — for both **Shorts** (9:16) and **long-form
documentary-style videos** (16:9).

It runs locally as a Node.js service with a web dashboard, driven by cron schedules.

> **Status:** working personal project, not a packaged product. It assumes a local
> macOS/Linux environment with FFmpeg and a few CLI tools available. Read
> [Requirements](#requirements) before cloning.

---

## Contents

- [How it works](#how-it-works)
- [Two pipelines](#two-pipelines)
- [Requirements](#requirements)
- [Setup](#setup)
- [Running it](#running-it)
- [HTTP API](#http-api)
- [Schedules](#schedules)
- [Configuration](#configuration)
- [Feedback loop](#feedback-loop)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Licence](#licence)

---

## How it works

Each video moves through a chain of agents, coordinated by `schedules/daily-automation.js`
(scheduled runs) or `index.js` (manual/API runs):

```
topic selection  →  script writing  →  thumbnail  →  SEO  →  production  →  publish
     │                    │                                      │
     │                    │                                      ├── narration (TTS)
     │                    │                                      ├── footage sourcing
     │                    │                                      ├── caption track
     │                    │                                      └── FFmpeg assembly
     │                    └── LLM via local router, with direct-provider fallback
     └── weighted angles × real view-count performance
```

| Agent | File | Responsibility |
|---|---|---|
| Content strategy | `agents/content-strategy-agent.js` | Picks the topic from weighted "angles", biased by real performance |
| Script writer | `agents/script-writer-agent.js` | Writes narration; long-form is outlined then written chapter by chapter |
| Thumbnail | `agents/thumbnail-designer-agent.js` | Generates a 1280×720 thumbnail with `sharp` |
| SEO | `agents/seo-optimizer-agent.js` | Title, description, tags, hashtags |
| Production | `agents/production-management-agent.js` | Narration, footage, captions, assembly |
| Publishing | `agents/publishing-scheduling-agent.js` | YouTube upload, thumbnail, captions, first comment |
| Analytics | `agents/analytics-optimization-agent.js` | Pulls YouTube Analytics; never fabricates missing data |

---

## Two pipelines

### Shorts — fully automated

Vertical 1080×1920. Runs unattended on a schedule and publishes without human involvement.
Narration uses Gemini TTS; background footage is stock or gameplay clips with burned-in captions.

### Long-form — automated, with a review gate

Landscape 1920×1080, typically 15–20 minutes. Triggered manually rather than on a schedule.

What differs from Shorts:

- **Chapter-structured script.** An outline of 7 chapters is generated first, then each chapter's
  narration is written separately. Writing to a ~400-word-per-chapter target reliably produces a
  3,000-word script, where asking for 3,000 words in one call does not.
- **Per-beat footage.** Each chapter carries its own `footageQuery`, so a stock clip is fetched
  *per chapter* and its on-screen duration is weighted to that chapter's share of the narration.
  The visuals change with the story rather than looping one background.
- **Free narration.** Uses `edge-tts` instead of Gemini TTS, which has a 15-requests-per-day free
  tier that a chunked long-form script would exhaust.
- **Review gate.** The finished video is staged in `data/review/` and **stops**. Nothing is
  uploaded until it is explicitly approved.

```
POST /generate {"format":"long"}   →  renders  →  data/review/  →  [you watch it]
                                                                        │
                                              POST /review/:id/approve  ▼  uploads
```

---

## Requirements

**Runtime**

- Node.js ≥ 18
- FFmpeg and FFprobe on `PATH`

**For captions** — [whisper.cpp](https://github.com/ggerganov/whisper.cpp)

- `whisper-cli` on `PATH`
- The model at `models/ggml-base.en.bin` (not in this repo — ~141 MB):

  ```bash
  mkdir -p models
  curl -L -o models/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```

**For long-form narration** — [edge-tts](https://github.com/rany2/edge-tts)

```bash
pip install edge-tts
```

Resolved from `EDGE_TTS_BIN`, then `PATH`. Free, no API key.

**API keys** — all free-tier:

| Service | Used for | Required |
|---|---|---|
| Google (Gemini) | Topic selection, footage search terms, Shorts TTS | Yes |
| YouTube Data API v3 | Uploading | Yes, for publishing |
| Pexels / Pixabay | Stock footage | Recommended |
| NVIDIA NIM | Script writing | Optional |

---

## Setup

> **Starting from scratch?** Follow the **[full setup guide](docs/SETUP.md)** — it covers
> installing the system tools, creating the Google Cloud project, and getting every API key,
> step by step.

```bash
git clone https://github.com/strangedeev/youtube-automation-agent.git
cd youtube-automation-agent
npm install
npm run setup
```

The wizard checks your environment, then asks for your channel name, a starting niche, and your
API keys. It writes `config/credentials.json` and your topic files, preserving anything already
configured and confirming before it overwrites.

Key input is hidden and never echoed. **`config/credentials.json` is gitignored and must never be
committed.**

Prefer to configure by hand? Copy the template instead:

```bash
cp config/credentials.example.json config/credentials.json
```

Either way, finish by authorising YouTube (writes `config/tokens.json`):

```bash
node oauth-server.js
```

---

## Running it

```bash
npm start
```

Serves the dashboard and API on **http://localhost:3456** and starts the cron schedules.

To keep it running via PM2:

```bash
pm2 start ecosystem.config.js
pm2 save
```

---

## HTTP API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Dashboard |
| `GET` | `/health` | Service and agent status |
| `GET` | `/status` | Live progress during generation |
| `POST` | `/generate` | Generate a video — `{"topic":"…","format":"short"\|"long"}` |
| `GET` | `/videos` | All produced videos |
| `GET` | `/schedule` | Upcoming and past scheduled posts |
| `GET` | `/stats`, `/stats/views` | Aggregate counts and view totals |
| `GET` | `/analytics` | Recent analytics reports |
| `GET` | `/analytics/angle-performance` | Per-angle performance and current weighting |
| `GET` | `/failures` | Recent automation failures with timestamps |
| `GET` | `/review` | Long-form videos awaiting review |
| `POST` | `/review/:contentId/approve` | **Uploads** an approved long-form video |
| `POST` | `/publish/:contentId` | **Uploads** a queued video |
| `POST` | `/sync-youtube` | Refresh view counts from YouTube |

> `POST /review/:id/approve` and `POST /publish/:id` publish to YouTube and are **not reversible**
> from this tool. Videos go live with the `channel.defaultPrivacy` from your credentials file —
> set it to `unlisted` or `private` if you want a safety margin.

---

## Schedules

Defined in `schedules/daily-automation.js` (server local time):

| Cron | When | Job |
|---|---|---|
| `0 12 * * *` | Daily, 12:00 | Generate and publish a Short |
| `*/15 * * * *` | Every 15 min | Process the publish queue |
| `0 9 * * *` | Daily, 09:00 | Collect analytics |
| `0 8 * * 0` | Sundays, 08:00 | Sync view counts; weekly strategy review |
| `0 22 * * *` | Daily, 22:00 | Optimisation pass |
| `0 3 * * 6` | Saturdays, 03:00 | Database maintenance |

Long-form is **not** scheduled — it only runs when you trigger it.

Failures are written to the `automation_events` table, surfaced on the dashboard's failures panel,
and raise a desktop notification.

---

## Configuration

### Channel name

Set during `npm run setup`, or edit `channel.channelName` in `config/credentials.json`. The
dashboard reads it from `/config` and uses it for the header logo and the browser tab title —
refresh to apply, no restart needed.

### Topics and angles

`config/topics.json` (Shorts) and `config/topics-longform.json` (long-form) define the content
strategy. The setup wizard writes them from a preset in `config/presets/`; edit them freely
afterwards, and changes apply on the next run.

Each **angle** is a content style with its own topic pool and a `weight` controlling how
often it is picked:

```jsonc
{
  "category": "Your Niche Here",
  "hashtags": ["#shorts"],
  "seoTags": {
    "niche": ["your niche keyword", "another niche keyword"],
    "broad": ["shorts", "did you know"]
  },
  "angles": [
    {
      "id": "main",
      "weight": 3,
      "contentStyle": "Describe the tone, pacing and structure you want — this text is passed straight to the model that writes the script, so be specific.",
      "topics": ["Write topics as you'd want them said aloud"]
    }
  ]
}
```

Higher `weight` means the angle is picked more often. `contentStyle` is passed straight to the
model that writes the script, so it is the strongest lever you have — be specific about tone and
pacing. Starter presets live in `config/presets/`; see the
[topics section of the setup guide](docs/SETUP.md#8-choosing-your-topics) for details.

### LLM provider

Script generation targets an OpenAI-compatible endpoint. If a `freellmapi` block is present in
credentials, requests route through that local router (which fails over across providers);
otherwise they go directly to NVIDIA NIM. Configured in `utils/nim-client.js`.

---

## Feedback loop

Published videos are tracked by ID. A weekly job pulls real view counts and averages them per
angle, producing a multiplier that biases future topic selection:

- Clamped to **0.5×–2×**, so a weak angle is never starved entirely
- Applied only once an angle has **3+ published videos**, so one lucky video can't skew selection

Visible on the dashboard under *Angle Performance*. When the YouTube Analytics API is unavailable,
analytics are **skipped rather than simulated** — the system never optimises against invented numbers.

---

## Security

- **No secrets in the repo.** `config/credentials.json` and `config/tokens.json` are gitignored,
  alongside defensive patterns for `.env`, `*.pem`, `*.key`, and service-account files. Only the
  placeholder `config/credentials.example.json` is tracked.
- **Secret redaction in logs.** Some providers take the API key as a URL query parameter, so a
  failed request's error message can embed the key. `utils/logger.js` redacts known key formats
  before anything reaches a log file, the database, or the dashboard.
- **Local-only surface.** The HTTP server has no authentication and binds to localhost. Do not
  expose port 3456 to the internet.
- **Generated media is not committed.** `data/` holds videos, audio, and the SQLite database.

Found a security issue? Open an issue — please don't include real credentials in the report.

---

## Known limitations

- **Stock footage is era-limited.** For historical topics, some beats return
  visually plausible but anachronistic clips. The footage query wording steers this, but it will
  not be perfect for pre-modern subjects.
- **Thumbnails are procedural.** Generated from a stock image plus text overlay. Adequate for
  Shorts; for long-form, where the thumbnail drives click-through, expect to replace it manually.
- **Encoding is slow.** A 17-minute 1080p render takes roughly 20 minutes on an M-series Mac while
  other services are running.
- **Dependency vulnerabilities.** `npm audit` reports outstanding advisories, mainly in the
  `sqlite3 → node-gyp` build toolchain. Remediating them requires breaking major upgrades.
- **Long-form review is manual by design.** There is no automatic quality gate; a human watches
  the video before it is approved.

---

## Licence

MIT — see [LICENSE](LICENSE).

Generated videos rely on third-party APIs and stock media. You are responsible for complying with
the terms of each provider (Google/YouTube, Pexels, Pixabay) and with YouTube's policies on
automated and mass-produced content.
