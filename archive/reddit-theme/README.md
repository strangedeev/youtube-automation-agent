# Archived: Reddit-Stories Theme

This documents the original **Reddit-stories** theme the channel ran before the
FIFA World Cup 2026 pivot to football content, and exactly how to restore it.

Nothing was deleted — the whole Reddit workflow still lives in the codebase. The
pivot to football is driven entirely by **`config/topics.json`**, so switching
themes is a one-file swap, not a code change.

---

## Switch themes (one command + restart)

```bash
# → FOOTBALL (current World Cup theme)
cp config/topics.football.json config/topics.json

# → REDDIT STORIES (restore the archived theme)
cp config/topics.reddit.json config/topics.json

# then reload the running process
pm2 restart youtube-automation     # or: pm2 restart vid-shock
```

`config/topics.json` is the single active config. Two ready-made versions sit
next to it: `topics.football.json` and `topics.reddit.json`. (You can also just
`rm config/topics.json` to fall back to the built-in Reddit drama defaults.)

---

## What each theme turns on

The theme is decided by fields in `config/topics.json`, all read at runtime:

| Field | Football | Reddit | Effect |
|-------|----------|--------|--------|
| `angles[].id` | `story` / `facts` / `prediction` / `recap` | `drama` | Which writing prompt the script writer uses (`agents/script-writer-agent.js → buildAnglePrompt`) |
| `introCard` | `false` | `true` | The Reddit-style intro card banner (`agents/production-management-agent.js → introCardEnabled`) |
| `hashtags` | football tags | `#reddit #aita …` | Video hashtags (`agents/seo-optimizer-agent.js → generateHashtags`) |
| `firstComments` | football prompts | "NTA or YTA?" prompts | Auto first comment (`agents/publishing-scheduling-agent.js → postFirstComment`) |
| `backgroundFolder` | `football` | *(unset)* | `football` → only `data/gameplay/football/`; unset → all gameplay subfolders |

All of these **default to the Reddit behaviour** when a field is absent, so the
old theme is the safe fallback.

---

## The Reddit writing prompt is preserved

When the script writer was made football-aware, the original confession-style
prompt was kept verbatim as the **`drama`** angle inside
`agents/script-writer-agent.js → buildAnglePrompt()` (`case 'drama'`). Football's
`story` angle is a separate, football-flavoured prompt. So restoring the Reddit
config (`angle: drama`) brings back the exact original story style.

## Other Reddit machinery still in the code (dormant, not removed)

- **Live Reddit fetching** — `agents/content-strategy-agent.js`: `fetchRedditStory()`,
  `scoreStoryQuality()`, and the subreddit list. Currently not on the primary
  path (the channel writes original stories), but intact.
- **Reddit post → narration rewrite** — `agents/script-writer-agent.js`: the
  `strategy.fullStory` branch in `generateFullScriptWithGemini()`.
- **Built-in drama premise bank** — `agents/content-strategy-agent.js`:
  `selectStoryPremise()` falls back to it when no `topics.json` is present.
- **Reddit intro card renderer** — `utils/reddit-card.js` (used whenever
  `introCard` is true).

---

## Files in this archive

- `archive/reddit-theme/README.md` — this file.
- `config/topics.reddit.json` — drop-in config to restore the Reddit theme.
- `config/topics.football.json` — backup of the current football config.

_Pivoted to football on 2026-06-09 for the World Cup. Restore Reddit whenever the
tournament ends._
