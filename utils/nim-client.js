const axios = require('axios');
const { Logger } = require('./logger');

// Primary: local freellmapi router (multi-provider failover across free tiers —
// serves the same Llama-class models via NVIDIA, Groq, Cloudflare and more,
// with per-key rate-limit ledgers and automatic 429 rerouting).
// Fallback: NVIDIA NIM direct — the original single-provider path — so script
// generation still works when the router process is down.
//
// Llama 4 Maverick remains the target model class: strongest open-weight model
// for creative writing. It handles dark/emotional cliffhanger story content far
// better than Gemini, which tends toward positive framing and verbose prose.
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = 'meta/llama-4-maverick-17b-128e-instruct';

class NIMClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey; // NVIDIA key (fallback path)
    this.routerUrl = options.routerUrl || null;   // e.g. http://localhost:3001/v1/chat/completions
    this.routerKey = options.routerKey || null;
    this.routerModel = options.routerModel || 'auto';
    this.logger = new Logger('NIM');
  }

  async _post(url, key, model, prompt, { temperature, maxTokens, timeoutMs }) {
    const response = await axios.post(
      url,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        top_p: 0.95,
        max_tokens: maxTokens
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs
      }
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in LLM response');
    return content.trim();
  }

  // Generate a completion. Router first (if configured), NVIDIA direct on any
  // router failure. temperature 0.9 + top_p 0.95 is the sweet spot for
  // emotional prose — default Q&A settings produce flat, lifeless writing.
  async generate(prompt, { temperature = 0.9, maxTokens = 1200, timeoutMs = 90000 } = {}) {
    if (this.routerUrl && this.routerKey) {
      try {
        return await this._post(this.routerUrl, this.routerKey, this.routerModel, prompt,
          { temperature, maxTokens, timeoutMs });
      } catch (err) {
        this.logger.warn(`Router failed (${err.message}) — falling back to NVIDIA direct`);
      }
    }
    if (!this.apiKey) throw new Error('No NVIDIA key configured and router unavailable');
    return this._post(NVIDIA_BASE_URL, this.apiKey, NVIDIA_MODEL, prompt,
      { temperature, maxTokens, timeoutMs });
  }

  // Generate and parse JSON output. Strips markdown fences and retries parse.
  // Models regularly emit a raw newline inside a JSON string value — a hard
  // parse error, even though the JSON is otherwise complete and correct. It
  // shows up most on longer narration fields, where the model breaks lines for
  // readability. Walk the text and escape any literal control character that
  // appears INSIDE a string, leaving structural whitespace untouched.
  static repairControlChars(s) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of s) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = !inString; out += ch; continue; }
      if (inString && ch <= '') {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '';
        continue;
      }
      out += ch;
    }
    return out;
  }

  async generateJSON(prompt, opts = {}) {
    const raw = await this.generate(prompt, opts);
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const attempts = [
      cleaned,
      NIMClient.repairControlChars(cleaned),
      // Models sometimes wrap JSON in prose — extract the first {...} block
      (cleaned.match(/\{[\s\S]*\}/) || [])[0],
      NIMClient.repairControlChars((cleaned.match(/\{[\s\S]*\}/) || [])[0] || '')
    ];

    for (const candidate of attempts) {
      if (!candidate) continue;
      try { return JSON.parse(candidate); } catch (_) { /* try the next repair */ }
    }
    throw new Error('Could not parse JSON from LLM response');
  }
}

module.exports = { NIMClient };
