'use strict';
/**
 * utils/api-caller.js — Gemini only, multi-key auto-rotation
 * All calls are Node.js HTTPS (no CORS).
 *
 * When a key hits quota/rate-limit, rotates to the next one automatically.
 * Returns { text, activeKeyIndex } so the renderer can update the UI.
 */

const https = require('https');

class ApiCaller {
  constructor(log) { this.log = log; }

  /**
   * @param {{ provider, model, messages, geminiKeys, activeKeyIndex, images }} opts
   * @returns {Promise<{ text, activeKeyIndex }>}
   */
  call(opts) {
    if (opts.provider !== 'gemini') return Promise.reject(new Error(`Unknown provider: ${opts.provider}`));
    return this._gemini(opts);
  }

  // ── Gemini (multi-key auto-rotation) ─────────────────────────────────────────
  async _gemini({ model, messages, geminiKeys, activeKeyIndex, apiKey, images }) {
    // Accept keys array (from renderer) or legacy single key
    const keys = (geminiKeys && geminiKeys.length > 0) ? geminiKeys : (apiKey ? [apiKey] : []);
    if (keys.length === 0) throw new Error('No Gemini API key configured. Add one in Settings.');

    model = model || 'gemini-3.8-flash';
    const startIdx = Math.max(0, Math.min(activeKeyIndex || 0, keys.length - 1));

    // Build Gemini contents array
    const contents = [];
    for (let i = 0; i < messages.length; i++) {
      const m    = messages[i];
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts = [{ text: m.content || ' ' }];
      if (i === messages.length - 1 && m.role === 'user' && images?.length) {
        for (const b64 of images) parts.push({ inline_data: { mime_type: 'image/png', data: b64 } });
      }
      contents.push({ role, parts });
    }
    const body = JSON.stringify({ contents });

    // Try each key starting from startIdx; rotate on quota errors
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const ki  = (startIdx + attempt) % keys.length;
      const key = keys[ki];
      this.log.info(`[api] gemini key ${ki + 1}/${keys.length}`);

      // Try /v1/ first, then /v1beta/
      for (const ver of ['v1', 'v1beta']) {
        const path = `/${ver}/models/${model}:generateContent?key=${key}`;
        try {
          const data = await this._post('generativelanguage.googleapis.com', path,
            { 'Content-Type': 'application/json' }, body);
          const json = JSON.parse(data);
          if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text && json.candidates?.[0]?.finishReason === 'SAFETY')
            throw new Error('Gemini blocked response (SAFETY filter). Try rephrasing.');
          // ✅ Success — return text + which key index worked
          return { text: text || '', activeKeyIndex: ki };
        } catch (e) {
          const msg = (e.message || '').toLowerCase();
          // Model not found → try next API version
          if (msg.includes('not found') || msg.includes('not supported') || msg.includes('invalid_argument'))
            continue;
          // Quota / rate-limit → rotate to next key
          if (this._isQuotaError(msg)) {
            this.log.warn(`[api] key ${ki + 1} quota exceeded — rotating to next key`);
            break; // break inner loop, try next key
          }
          // Other error (auth, network) — throw immediately
          throw e;
        }
      }
    }
    throw new Error('All Gemini API keys exhausted. Add more keys in Settings.');
  }

  // Detect quota / rate-limit errors
  _isQuotaError(msg) {
    return msg.includes('quota')          || msg.includes('exhausted')     ||
           msg.includes('rate limit')     || msg.includes('resource_exhausted') ||
           msg.includes('429')            || msg.includes('high demand')   ||
           msg.includes('too many req')   || msg.includes('no longer available');
  }

  // ── HTTP POST ─────────────────────────────────────────────────────────────────
  _post(hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname, path, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            let errMsg = `HTTP ${res.statusCode}`;
            try { errMsg = JSON.parse(data)?.error?.message || errMsg; } catch (_) {}
            reject(new Error(errMsg));
          } else { resolve(data); }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('Timeout (30s)')));
      req.write(body); req.end();
    });
  }
}

module.exports = ApiCaller;
