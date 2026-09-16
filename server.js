const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = 3000;
const GEMINI_MODEL = 'gemini-3.6-flash';

app.use(cors());
app.use(express.json({ limit: '30mb' })); // raised from 20mb — voice messages base64-encode larger than screenshots

/* ------------------------------------------------------------------ */
/* STATIC FRONTEND                                                      */
/* Put your index.html (and any assets) in a "public" folder next to    */
/* this file. The app is then served at http://localhost:3000/          */
/* ------------------------------------------------------------------ */
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Siteline-Gemini.html'));
});

/* ------------------------------------------------------------------ */
/* STORAGE — replaces the Claude-artifact "window.storage" API that     */
/* the frontend used to call. window.storage only exists inside         */
/* Claude.ai's artifact sandbox, so once this app runs on its own it    */
/* needs a real backend to persist to. This is a simple JSON-file       */
/* store: fine for a hackathon demo, not a substitute for a real DB     */
/* if this ever needs to handle concurrent writes at scale.             */
/* ------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ shared: {}, personal: {} }, null, 2));
  }
}
ensureDataFile();

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { shared: {}, personal: {} };
  }
}

// Serialize writes so two rapid saves can't clobber each other or corrupt the file.
let writeQueue = Promise.resolve();
function writeStore(store) {
  writeQueue = writeQueue.then(() =>
    fs.promises.writeFile(DATA_FILE, JSON.stringify(store, null, 2))
  );
  return writeQueue;
}

function scopeFor(store, shared, clientId) {
  if (shared) return store.shared;
  if (!store.personal[clientId]) store.personal[clientId] = {};
  return store.personal[clientId];
}

function getClientId(req) {
  return (req.header('x-client-id') || 'anonymous').slice(0, 128);
}

app.post('/api/storage/set', async (req, res) => {
  try {
    const { key, value, shared } = req.body || {};
    if (!key) return res.status(400).json({ error: { message: 'Missing key' } });
    const store = readStore();
    const scope = scopeFor(store, !!shared, getClientId(req));
    scope[key] = value;
    await writeStore(store);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/api/storage/get', (req, res) => {
  try {
    const { key, shared } = req.query;
    if (!key) return res.status(400).json({ error: { message: 'Missing key' } });
    const store = readStore();
    const scope = scopeFor(store, shared === 'true', getClientId(req));
    if (!(key in scope)) return res.status(404).json({ error: { message: 'Not found' } });
    res.json({ key, value: scope[key] });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/api/storage/list', (req, res) => {
  try {
    const prefix = req.query.prefix || '';
    const shared = req.query.shared === 'true';
    const store = readStore();
    const scope = scopeFor(store, shared, getClientId(req));
    const keys = Object.keys(scope).filter(k => k.startsWith(prefix));
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.delete('/api/storage/delete', async (req, res) => {
  try {
    const { key, shared } = req.body || {};
    if (!key) return res.status(400).json({ error: { message: 'Missing key' } });
    const store = readStore();
    const scope = scopeFor(store, !!shared, getClientId(req));
    delete scope[key];
    await writeStore(store);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/* ------------------------------------------------------------------ */
/* GEMINI PROXY (unchanged from your version)                           */
/* ------------------------------------------------------------------ */
function convertContentToGemini(content) {
  if (typeof content === 'string') {
    return [{
      role: 'user',
      parts: [{ text: content }]
    }];
  }

  if (!Array.isArray(content)) {
    throw new Error('Invalid content format. Expected text or content blocks.');
  }

  const parts = [];

  for (const block of content) {
    if (!block) continue;

    if (block.type === 'text') {
      parts.push({ text: block.text || '' });
      continue;
    }

    if (block.type === 'image') {
      if (!block.source?.data || !block.source?.media_type) {
        throw new Error('Invalid image attachment.');
      }
      parts.push({
        inline_data: {
          mime_type: block.source.media_type,
          data: block.source.data
        }
      });
      continue;
    }

    if (block.type === 'document') {
      if (!block.source?.data || !block.source?.media_type) {
        throw new Error('Invalid PDF attachment.');
      }
      parts.push({
        inline_data: {
          mime_type: block.source.media_type,
          data: block.source.data
        }
      });
      continue;
    }

    if (block.type === 'audio') {
      if (!block.source?.data || !block.source?.media_type) {
        throw new Error('Invalid audio attachment.');
      }
      parts.push({
        inline_data: {
          mime_type: block.source.media_type,
          data: block.source.data
        }
      });
      continue;
    }
  }

  if (parts.length === 0) {
    throw new Error('No usable content was provided.');
  }

  return [{ role: 'user', parts }];
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    provider: 'Google Gemini',
    model: GEMINI_MODEL
  });
});

app.post('/api/gemini', async (req, res) => {
  try {
    const { content, maxTokens } = req.body;

    if (!content) {
      return res.status(400).json({
        error: { message: 'Missing content in request.' }
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: { message: 'GEMINI_API_KEY is missing from the .env file.' }
      });
    }

    const contents = convertContentToGemini(content);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            maxOutputTokens: Number(maxTokens) || 1000,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const data = await response.json();

    console.log('Gemini status:', response.status);

    if (!response.ok) {
      console.error('Gemini API error:', JSON.stringify(data, null, 2));
      return res.status(response.status).json(data);
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || '')
      .join('\n');

    if (!text) {
      return res.status(502).json({
        error: { message: 'Gemini returned an empty response.' },
        raw: data
      });
    }

    // Return a Claude-compatible shape so the existing SiteLine parser keeps working.
    res.json({
      content: [{ text }]
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

app.listen(PORT, () => {
  console.log(`SiteLine backend running at http://localhost:${PORT}`);
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Storage file: ${DATA_FILE}`);
});