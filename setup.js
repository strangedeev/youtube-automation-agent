#!/usr/bin/env node
/**
 * First-run setup wizard.
 *
 *   npm run setup
 *
 * Asks for the channel name, a starting niche, and API keys, then writes
 * config/credentials.json and config/topics{,-longform}.json.
 *
 * Safety rules this file follows:
 *   - never overwrites an existing file without an explicit confirmation
 *   - never prints a key back to the terminal
 *   - merges into existing credentials rather than replacing them, so leaving
 *     an answer blank keeps whatever was already configured
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const inquirer = require('inquirer');

const ROOT = __dirname;
const CONFIG_DIR = path.join(ROOT, 'config');
const PRESET_DIR = path.join(CONFIG_DIR, 'presets');
const CRED_PATH = path.join(CONFIG_DIR, 'credentials.json');
const TOPICS_PATH = path.join(CONFIG_DIR, 'topics.json');
const TOPICS_LONG_PATH = path.join(CONFIG_DIR, 'topics-longform.json');
const WHISPER_MODEL = path.join(ROOT, 'models', 'ggml-base.en.bin');

const c = {
  bold: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`
};

function has(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

// Mirrors utils/edge-tts.js resolution: env override, then PATH, then a
// sibling MoneyPrinterTurbo venv.
function edgeTTSAvailable() {
  if (process.env.EDGE_TTS_BIN && fs.existsSync(process.env.EDGE_TTS_BIN)) return true;
  if (has('edge-tts')) return true;
  return fs.existsSync(path.resolve(
    ROOT, '..', '..', 'MoneyPrinterTurbo', '.venv', 'bin', 'edge-tts'
  ));
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// ── 1. Environment check ────────────────────────────────────────────────────
function checkEnvironment() {
  console.log(c.bold('\nChecking your environment\n'));

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const rows = [
    ['Node.js >= 18', nodeMajor >= 18, `found v${process.versions.node}`, true],
    ['ffmpeg', has('ffmpeg'), 'required to assemble video', true],
    ['ffprobe', has('ffprobe'), 'required to read media durations', true],
    ['whisper-cli', has('whisper-cli'), 'needed for burned-in captions', false],
    ['whisper model', fs.existsSync(WHISPER_MODEL), 'models/ggml-base.en.bin', false],
    // Use the same resolution order as the runtime so this never reports a
    // false negative for a binary the app would actually find.
    ['edge-tts', edgeTTSAvailable(), 'free narration for long-form', false]
  ];

  let blocking = false;
  for (const [name, ok, note, required] of rows) {
    const mark = ok ? c.green('  ok  ') : (required ? c.red(' MISS ') : c.yellow(' warn '));
    console.log(`  ${mark} ${name.padEnd(16)} ${c.dim(note)}`);
    if (!ok && required) blocking = true;
  }

  if (blocking) {
    console.log(c.red('\nSomething required is missing. Install it, then run setup again.'));
    console.log(c.dim('  macOS:  brew install ffmpeg'));
    console.log(c.dim('  Ubuntu: sudo apt install ffmpeg\n'));
    process.exit(1);
  }

  const optionalMissing = rows.filter(([, ok, , req]) => !ok && !req);
  if (optionalMissing.length) {
    console.log(c.yellow('\n  Optional tools are missing — see docs/SETUP.md.'));
    console.log(c.dim('  Videos will still generate; captions or long-form narration may not.'));
  }
}

// ── 2. Prompts ──────────────────────────────────────────────────────────────
function loadPresets() {
  if (!fs.existsSync(PRESET_DIR)) return [];
  return fs.readdirSync(PRESET_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJSON(path.join(PRESET_DIR, f)))
    .filter(Boolean);
}

async function run() {
  console.log(c.bold(c.cyan('\n  YouTube Automation Agent — setup\n')));
  checkEnvironment();

  const existingCreds = readJSON(CRED_PATH);
  if (existingCreds) {
    console.log(c.yellow('\n  config/credentials.json already exists.'));
    console.log(c.dim('  Leave any answer blank to keep the current value.'));
  }

  const presets = loadPresets();
  console.log(c.bold('\nChannel\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'channelName',
      message: 'Channel name (shown in the dashboard and used for branding):',
      default: existingCreds?.channel?.channelName || undefined,
      validate: v => (v && v.trim().length >= 2) || 'Please enter a channel name.'
    },
    {
      type: 'input',
      name: 'channelDescription',
      message: 'One-line channel description:',
      default: existingCreds?.channel?.channelDescription || undefined
    },
    {
      type: 'list',
      name: 'privacy',
      message: 'Privacy for uploaded videos:',
      choices: [
        { name: 'unlisted  — safest while testing (recommended)', value: 'unlisted' },
        { name: 'private   — only you can see them', value: 'private' },
        { name: 'public    — live immediately, not reversible from this tool', value: 'public' }
      ],
      default: existingCreds?.channel?.defaultPrivacy || 'unlisted'
    }
  ]);

  let preset = null;
  if (presets.length) {
    console.log(c.bold('\nContent\n'));
    const { presetId } = await inquirer.prompt([{
      type: 'list',
      name: 'presetId',
      message: 'Pick a starting niche (you can edit the topics afterwards):',
      choices: [
        ...presets.map(p => ({ name: p.label || p.id, value: p.id })),
        { name: c.dim('Keep my existing config/topics.json'), value: '__keep__' }
      ]
    }]);
    if (presetId !== '__keep__') preset = presets.find(p => p.id === presetId);
  }

  console.log(c.bold('\nAPI keys'), c.dim('(input is hidden; blank keeps any existing value)\n'));
  const keys = await inquirer.prompt([
    {
      type: 'password', name: 'gemini', mask: '*',
      message: 'Google Gemini API key (required — topic selection, TTS, search terms):'
    },
    { type: 'password', name: 'pexels', mask: '*', message: 'Pexels API key (stock footage, optional):' },
    { type: 'password', name: 'pixabay', mask: '*', message: 'Pixabay API key (stock footage, optional):' },
    { type: 'password', name: 'nvidia', mask: '*', message: 'NVIDIA NIM API key (script writing, optional):' }
  ]);

  console.log(c.bold('\nYouTube OAuth'), c.dim('(from Google Cloud Console — see docs/SETUP.md)\n'));
  const oauth = await inquirer.prompt([
    { type: 'input', name: 'clientId', message: 'OAuth client ID:', default: existingCreds?.youtube?.client_id || undefined },
    { type: 'password', name: 'clientSecret', mask: '*', message: 'OAuth client secret:' }
  ]);

  // ── 3. Build credentials, merging over anything already configured ────────
  const creds = existingCreds ? JSON.parse(JSON.stringify(existingCreds)) : {};
  const keep = (existing, incoming) => (incoming && incoming.trim() ? incoming.trim() : existing);

  creds.youtube = {
    client_id: keep(creds.youtube?.client_id, oauth.clientId),
    client_secret: keep(creds.youtube?.client_secret, oauth.clientSecret),
    redirect_uris: creds.youtube?.redirect_uris || ['http://localhost:8080/oauth2callback']
  };
  creds.gemini  = { apiKey: keep(creds.gemini?.apiKey, keys.gemini) };
  creds.pexels  = { apiKey: keep(creds.pexels?.apiKey, keys.pexels) };
  creds.pixabay = { apiKey: keep(creds.pixabay?.apiKey, keys.pixabay) };
  creds.nvidia  = { apiKey: keep(creds.nvidia?.apiKey, keys.nvidia) };

  creds.channel = {
    ...(creds.channel || {}),
    channelName: answers.channelName.trim(),
    channelDescription: answers.channelDescription || creds.channel?.channelDescription || '',
    defaultCategory: creds.channel?.defaultCategory || '24',
    defaultPrivacy: answers.privacy
  };
  creds.content = creds.content || {
    contentTypes: ['story'],
    targetAudience: '',
    postingFrequency: 'daily',
    preferredPostTime: '12:00'
  };

  if (fs.existsSync(CRED_PATH)) {
    const { ok } = await inquirer.prompt([{
      type: 'confirm', name: 'ok', default: true,
      message: 'Update config/credentials.json with these values?'
    }]);
    if (!ok) { console.log(c.yellow('\nAborted — nothing was written.\n')); return; }
  }
  writeJSON(CRED_PATH, creds);
  console.log(c.green('\n  wrote config/credentials.json') + c.dim('  (gitignored — never commit this)'));

  // ── 4. Topics ─────────────────────────────────────────────────────────────
  if (preset) {
    let proceed = true;
    if (fs.existsSync(TOPICS_PATH)) {
      const { ok } = await inquirer.prompt([{
        type: 'confirm', name: 'ok', default: false,
        message: `Overwrite config/topics.json with the "${preset.id}" preset? (your current topics will be replaced)`
      }]);
      proceed = ok;
    }
    if (proceed) {
      writeJSON(TOPICS_PATH, preset.short);
      writeJSON(TOPICS_LONG_PATH, preset.long);
      console.log(c.green('  wrote config/topics.json and config/topics-longform.json'));
    } else {
      console.log(c.dim('  kept your existing topics files'));
    }
  }

  // ── 5. Next steps ─────────────────────────────────────────────────────────
  const needsOAuth = !fs.existsSync(path.join(CONFIG_DIR, 'tokens.json'));
  console.log(c.bold('\nNext steps\n'));
  let n = 1;
  if (needsOAuth) {
    console.log(`  ${n++}. Authorise YouTube:      ${c.cyan('node oauth-server.js')}`);
  }
  if (!fs.existsSync(WHISPER_MODEL)) {
    console.log(`  ${n++}. Download captions model (see ${c.cyan('docs/SETUP.md')})`);
  }
  console.log(`  ${n++}. Start the agent:       ${c.cyan('npm start')}`);
  console.log(`  ${n++}. Open the dashboard:    ${c.cyan('http://localhost:3456')}`);
  console.log(c.dim(`\n  Your dashboard will be branded "${answers.channelName.trim()}".`));
  console.log(c.dim(`  Videos will upload as ${answers.privacy}.\n`));
}

run().catch(err => {
  if (err && err.isTtyError) {
    console.error(c.red('\nThis wizard needs an interactive terminal.'));
    console.error(c.dim('Copy config/credentials.example.json to config/credentials.json and edit it by hand.\n'));
  } else {
    console.error(c.red(`\nSetup failed: ${err.message}\n`));
  }
  process.exit(1);
});
