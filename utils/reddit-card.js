const sharp = require('sharp');
const { Logger } = require('./logger');

// Renders the Reddit-style intro card (white rounded card with avatar, handle,
// verified tick, the AskReddit-style question, and like/share counts) as a
// transparent PNG sized to overlay on a 1080-wide vertical video.

const CARD_W = 960;        // card width (centred on the 1080 canvas → 60px side margins)
const PAD = 48;            // inner padding
const AVATAR = 96;         // avatar diameter

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Greedy word-wrap for the question text at a given max chars/line.
function wrap(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > maxChars) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

class RedditCard {
  constructor() {
    this.logger = new Logger('RedditCard');
  }

  // questionText: the card line. handle: channel name (without @). outPath: png.
  async render(questionText, handle, outPath) {
    const q = (questionText || '').trim() || 'What is the worst thing someone has done to you?';
    const name = (handle || 'Storytime').replace(/^@/, '');

    const qLines = wrap(q, 34);
    const qFontSize = 44;
    const qLineH = 58;

    const headerTop = PAD;
    const headerH = AVATAR;
    const qTop = headerTop + headerH + 40;
    const qBlockH = qLines.length * qLineH;
    const footTop = qTop + qBlockH + 36;
    const footH = 40;
    const CARD_H = footTop + footH + PAD;

    const qTextSvg = qLines.map((line, i) =>
      `<text x="${PAD}" y="${qTop + i * qLineH + qFontSize * 0.8}"
        font-family="Montserrat" font-weight="800" font-size="${qFontSize}"
        fill="#0b1416">${escapeXml(line)}</text>`
    ).join('\n');

    const avatarCx = PAD + AVATAR / 2;
    const avatarCy = headerTop + AVATAR / 2;
    const handleX  = PAD + AVATAR + 28;
    const handleY  = avatarCy + 14;

    const svg = `<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="av" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff7a59"/><stop offset="100%" stop-color="#ff3d6e"/>
        </linearGradient>
        <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="8" stdDeviation="18" flood-color="#000" flood-opacity="0.35"/>
        </filter>
      </defs>

      <!-- card body -->
      <rect x="6" y="6" width="${CARD_W - 12}" height="${CARD_H - 12}" rx="40" ry="40"
            fill="#ffffff" filter="url(#cardShadow)"/>

      <!-- avatar -->
      <circle cx="${avatarCx}" cy="${avatarCy}" r="${AVATAR / 2}" fill="url(#av)"/>
      <circle cx="${avatarCx}" cy="${avatarCy - 8}" r="16" fill="#ffffff" opacity="0.95"/>
      <ellipse cx="${avatarCx}" cy="${avatarCy + 26}" rx="26" ry="18" fill="#ffffff" opacity="0.95"/>

      <!-- handle + verified tick -->
      <text x="${handleX}" y="${handleY}" font-family="Montserrat" font-weight="800"
            font-size="40" fill="#0b1416">@${escapeXml(name)}</text>
      <circle cx="${handleX + this._estWidth(name, 40) + 70}" cy="${avatarCy + 1}" r="20" fill="#1d9bf0"/>
      <path d="M ${handleX + this._estWidth(name, 40) + 60} ${avatarCy + 1}
               l 7 8 l 14 -16" stroke="#ffffff" stroke-width="5" fill="none"
               stroke-linecap="round" stroke-linejoin="round"/>

      <!-- question -->
      ${qTextSvg}

      <!-- footer: heart + share counts -->
      <path d="M ${PAD + 12} ${footTop + 14}
               a 12 12 0 0 1 17 0 a 12 12 0 0 1 17 0
               q 0 14 -17 26 q -17 -12 -17 -26 z"
            fill="#ff3d6e" transform="translate(-4,-6)"/>
      <text x="${PAD + 54}" y="${footTop + 28}" font-family="Montserrat" font-weight="700"
            font-size="30" fill="#5a6b70">99+</text>

      <path d="M ${CARD_W - PAD - 190} ${footTop + 6}
               l 36 -14 l 0 9 q 30 2 30 30 q -12 -16 -30 -14 l 0 9 z"
            fill="#5a6b70"/>
      <text x="${CARD_W - PAD - 95}" y="${footTop + 28}" font-family="Montserrat" font-weight="700"
            font-size="30" fill="#5a6b70" text-anchor="end">99+</text>
    </svg>`;

    await sharp(Buffer.from(svg)).png().toFile(outPath);
    this.logger.info(`Reddit card rendered: @${name} — "${q.slice(0, 40)}..."`);
    return { path: outPath, width: CARD_W, height: CARD_H };
  }

  // Rough text width estimate for positioning the verified tick after the handle.
  _estWidth(text, fontSize) {
    return Math.round(('@' + text).length * fontSize * 0.56);
  }
}

module.exports = { RedditCard, CARD_W };
