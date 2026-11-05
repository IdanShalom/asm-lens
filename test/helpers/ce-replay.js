// Compiler Explorer responses for tests: replayed from test/fixtures/ce, or
// (with ASM_LENS_RECORD=1) fetched live and saved there. Each request is keyed
// by its URL path and body, so a changed request needs a new recording.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'fixtures', 'ce');
const RECORD = process.env.ASM_LENS_RECORD === '1';
const LIVE = process.env.ASM_LENS_REMOTE === '1';

function keyOf(url, body) {
  const route = String(url).replace(/^https?:\/\/[^/]+/, '');
  return crypto.createHash('sha1').update(`${route}\n${body || ''}`).digest('hex').slice(0, 20);
}

// Replaces global fetch. Returns { restore, requests }.
function installFetch() {
  const realFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    const key = keyOf(url, init.body);
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined, key });
    const file = path.join(DIR, `${key}.json.gz`);
    if (LIVE && !RECORD) return realFetch(url, init);
    if (RECORD) {
      // Spaced out, to stay within Compiler Explorer's rate limit.
      await new Promise(r => setTimeout(r, 1500));
      let res = await realFetch(url, init);
      // A server having a bad moment is waited for, and never saved as if it were the answer.
      for (let wait = 15000; res.status >= 500 && wait <= 120000; wait *= 2) {
        await new Promise(r => setTimeout(r, wait));
        res = await realFetch(url, init);
      }
      if (res.status === 429) throw new Error('Compiler Explorer rate limit (HTTP 429) while recording; wait a few minutes and record again.');
      if (res.status >= 500) throw new Error(`Compiler Explorer answered HTTP ${res.status} while recording; try again later.`);
      const text = await res.text();
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ url: String(url).replace(/^https?:\/\/[^/]+/, ''), status: res.status, body: text })));
      return response(res.status, text);
    }
    if (!fs.existsSync(file)) throw new Error(`No recorded Compiler Explorer response for ${url} (${key}). Run: node test/run.js --record`);
    const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    return response(saved.status, saved.body);
  };
  return { restore: () => { global.fetch = realFetch; }, requests };
}

function response(status, text) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}

module.exports = { installFetch, RECORD, LIVE };
