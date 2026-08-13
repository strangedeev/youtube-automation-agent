# Setup guide

A complete walkthrough from a fresh machine to your first generated video.

Budget about **30–45 minutes**, most of it waiting on Google Cloud. Everything here uses
free tiers.

---

## Contents

1. [What you'll need](#1-what-youll-need)
2. [Install the system tools](#2-install-the-system-tools)
3. [Get the code](#3-get-the-code)
4. [Get your API keys](#4-get-your-api-keys)
5. [Run the setup wizard](#5-run-the-setup-wizard)
6. [Authorise YouTube](#6-authorise-youtube)
7. [First run](#7-first-run)
8. [Choosing your topics](#8-choosing-your-topics)
9. [Naming your channel](#9-naming-your-channel)
10. [Going live safely](#10-going-live-safely)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. What you'll need

- A **Google account** (for the Gemini API and the YouTube channel you'll publish to)
- A **YouTube channel** you own
- **macOS or Linux.** Windows works through WSL2; the notification and some shell calls assume a
  Unix environment.
- Roughly **10 GB free disk**. Rendered long-form videos are large, and the pipeline keeps
  intermediate footage until a video completes.

Everything below is free. No paid API tier is required.

---

## 2. Install the system tools

### Node.js 18 or newer

```bash
node --version    # must print v18 or higher
```

If not installed: [nodejs.org](https://nodejs.org/) or `brew install node`.

### FFmpeg (required)

Assembles every video. Without it nothing renders.

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt update && sudo apt install ffmpeg

ffmpeg -version && ffprobe -version
```

### whisper.cpp (needed for captions)

Transcribes narration to word-level timings so captions can be burned in.

```bash
# macOS
brew install whisper-cpp

# or build from source: https://github.com/ggerganov/whisper.cpp
```

Then download the model — it is **not** in this repo (~141 MB):

```bash
mkdir -p models
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

The path must be exactly `models/ggml-base.en.bin`.

### edge-tts (needed for long-form narration)

Free Microsoft Edge text-to-speech. Long-form uses this instead of Gemini TTS, whose free tier
allows only 15 requests a day.

```bash
pip install edge-tts
edge-tts --list-voices | head
```

If it isn't on your `PATH`, set `EDGE_TTS_BIN` to its full path.

---

## 3. Get the code

```bash
git clone https://github.com/strangedeev/youtube-automation-agent.git
cd youtube-automation-agent
npm install
```

---

## 4. Get your API keys

### 4a. Google Cloud project and OAuth

This is the fiddliest part. Take it slowly.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and **create a project**.

2. **Enable three APIs.** Under *APIs & Services → Library*, search for and enable each:
   - **YouTube Data API v3** — uploading videos
   - **YouTube Analytics API** — performance data driving the feedback loop
   - **Generative Language API** — Gemini

   > Missing the Analytics API is the most common setup mistake. Without it, analytics are
   > skipped entirely (the system never invents numbers, so you simply get no data).

3. **Configure the OAuth consent screen** (*APIs & Services → OAuth consent screen*):
   - User type: **External**
   - Fill in app name, your email, developer contact
   - Under *Test users*, **add your own Google account** — required while the app is unpublished
   - You do not need to submit for verification for personal use

4. **Create OAuth credentials** (*APIs & Services → Credentials → Create Credentials → OAuth client ID*):
   - Application type: **Web application**
   - Under *Authorised redirect URIs*, add exactly:

     ```
     http://localhost:8080/oauth2callback
     ```

   - Save, then copy the **Client ID** and **Client Secret**

   The port must be `8080` — that's what `oauth-server.js` listens on.

### 4b. Gemini API key

Go to [Google AI Studio](https://aistudio.google.com/app/apikey) → **Create API key**, and select
the same Cloud project. Used for topic selection, footage search terms, and Shorts narration.

### 4c. Stock footage keys (strongly recommended)

Both are free and instant:

- **Pexels** — [pexels.com/api](https://www.pexels.com/api/) (200 requests/hour, 20,000/month)
- **Pixabay** — [pixabay.com/api/docs](https://pixabay.com/api/docs/)

Without at least one, the pipeline has no footage to work with.

### 4d. NVIDIA NIM key (optional)

[build.nvidia.com](https://build.nvidia.com/) — free developer tier, used for script writing.
If omitted, scripts fall back to Gemini.

---

## 5. Run the setup wizard

```bash
npm run setup
```

It will:

- check every tool above and tell you what's missing
- ask for your **channel name**, description, and upload privacy
- let you pick a **starting niche** from the presets in `config/presets/`
- take your API keys with **hidden input**
- write `config/credentials.json` and your topic files

Notes:

- Key input is masked and never echoed back.
- Existing values are preserved — leave an answer blank to keep what's there.
- It will **ask before overwriting** anything that already exists.
- `config/credentials.json` is gitignored. Never commit it.

Prefer doing it by hand? Copy the template instead:

```bash
cp config/credentials.example.json config/credentials.json
```

---

## 6. Authorise YouTube

```bash
node oauth-server.js
```

A browser window opens asking you to grant access. You'll see an "unverified app" warning —
expected for a personal project; choose **Advanced → Go to (app name)**.

The requested scopes are:

| Scope | Why |
|---|---|
| `youtube.upload` | Upload videos |
| `youtube` | Set thumbnails, captions, post the first comment |
| `youtube.readonly` | Read back video stats |
| `yt-analytics.readonly` | Performance data for the feedback loop |

On success, `config/tokens.json` is written (also gitignored). You only do this once — tokens
refresh automatically.

---

## 7. First run

```bash
npm start
```

Open **http://localhost:3456**. The dashboard should be branded with your channel name.

Generate your first Short from the dashboard, or:

```bash
curl -X POST http://localhost:3456/generate \
  -H "Content-Type: application/json" \
  -d '{"format":"short"}'
```

Takes a few minutes. Watch progress on the dashboard.

For long-form (15–20 min video, ~20 min render):

```bash
curl -X POST http://localhost:3456/generate \
  -H "Content-Type: application/json" \
  -d '{"topic":"Your subject here","format":"long"}'
```

Long-form **does not upload**. It renders into `data/review/` and stops so you can watch it first.
See [Going live safely](#10-going-live-safely).

### Keeping it running

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

The schedules (Shorts daily at noon, analytics, weekly review) only fire while the process runs.

---

## 8. Choosing your topics

Your content strategy lives in two files:

| File | Used for |
|---|---|
| `config/topics.json` | Shorts |
| `config/topics-longform.json` | Long-form |

The wizard writes these from a preset in `config/presets/`. You can edit them at any time —
changes are picked up on the next run, no restart needed.

### Structure

```jsonc
{
  "category": "Science / Mystery / History Facts",
  "hashtags": ["#facts", "#shorts"],
  "firstComments": ["Which one surprised you? 👇"],
  "seoTags": {
    "niche": ["history facts", "true stories"],   // your niche keywords
    "broad": ["shorts", "did you know"]           // high-volume discovery tags
  },
  "angles": [
    {
      "id": "unexplained",
      "weight": 4,
      "contentStyle": "rapid-fire compilations of real documented events…",
      "topics": [
        "Unexplained events witnessed by entire towns at the same time",
        "Signals scientists recorded and still cannot trace"
      ]
    }
  ]
}
```

### The three things that matter

**`angles`** — each is a content *format*, not just a subject. One video = one angle, then one
topic from that angle's pool.

**`weight`** — how often an angle gets picked, relative to the others. Weight 6 against weight 2
means roughly three times as often. Set an angle to a high weight when it's working.

**`contentStyle`** — passed **directly to the model that writes the script**. This is your
strongest lever. Be specific about tone, pacing, how long each beat runs, and how videos end.
Vague style text produces generic scripts.

### Adding your own angle

```jsonc
{
  "id": "my-angle",
  "weight": 5,
  "contentStyle": "calm, measured delivery. Open on the single strangest detail, then explain how it happened chronologically. End on the unresolved part.",
  "topics": [
    "Write topics the way you'd want them said out loud",
    "Specific beats a script writer can actually build on"
  ]
}
```

Topics are consumed as-is, so write them as real subjects rather than keywords. The system avoids
repeating any topic used in the last 30 days.

### Let the data choose for you

Once an angle has **3+ published videos**, real view counts start biasing selection automatically
(clamped 0.5×–2×, so nothing gets starved). Watch it under *Angle Performance* on the dashboard,
and raise the `weight` of whatever wins.

---

## 9. Naming your channel

Set during setup, stored at `channel.channelName` in `config/credentials.json`:

```jsonc
"channel": {
  "channelName": "Your Channel Name",
  "defaultPrivacy": "unlisted"
}
```

The dashboard reads this from `/config` on load and uses it for both the header logo and the
browser tab title. To change it, edit the value and refresh — no restart required.

Re-running `npm run setup` updates it too, and leaves your other settings alone.

---

## 10. Going live safely

**Uploads are irreversible from this tool.** Videos publish with whatever
`channel.defaultPrivacy` says.

Start with:

```jsonc
"defaultPrivacy": "unlisted"
```

Then watch a few full videos before switching to `public`. Shorts publish automatically on the
daily schedule, so this setting is the only thing standing between a bad render and your
subscribers.

Long-form has a second layer of protection — it stages to `data/review/` and waits:

```bash
curl http://localhost:3456/review                      # see what's waiting
curl -X POST http://localhost:3456/review/<id>/approve # uploads it
```

Only run the approve call once you've actually watched the file.

---

## 11. Troubleshooting

**`ffmpeg: command not found`, or videos never assemble**
FFmpeg isn't on your `PATH`. Re-check step 2.

**Captions are missing from finished videos**
`whisper-cli` isn't installed, or `models/ggml-base.en.bin` is missing or truncated. Confirm the
file is ~141 MB.

**Long-form narration fails**
edge-tts isn't reachable. Run `edge-tts --list-voices`; if that fails, `pip install edge-tts` or
set `EDGE_TTS_BIN`.

**`YouTube Analytics API has not been used in project …`**
You skipped that API in step 4a. Enable it, then wait a few minutes to propagate. Analytics are
skipped until then — nothing else breaks.

**`403` or `401` from Gemini**
Either the key is wrong, or **Generative Language API** isn't enabled on the project.

**TTS suddenly stops working partway through the day**
Gemini TTS free tier is 3 requests/minute and 15/day. That ceiling is why long-form uses edge-tts.

**Uploads fail after ~6 videos in a day**
YouTube Data API gives 10,000 quota units/day and an upload costs ~1,600 — about six uploads.
Resets at midnight Pacific.

**Redirect URI mismatch during OAuth**
It must be exactly `http://localhost:8080/oauth2callback` — no trailing slash, port 8080.

**Repeated topics**
Only the last 30 days are excluded, and only within a format. Add more topics to the angle's pool.

**Where did my video go?**
Shorts upload and the local file is deleted afterwards (YouTube is the copy of record). Long-form
sits in `data/review/` until approved. Failures appear on the dashboard's *Recent failures* panel
with timestamps, and raise a desktop notification.

---

Still stuck? Open an issue — but never paste real credentials into a bug report.
