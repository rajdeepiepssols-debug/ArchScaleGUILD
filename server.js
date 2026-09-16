const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Three separate Groq models, picked per-request depending on what's attached:
const GROQ_TEXT_MODEL = 'openai/gpt-oss-120b';                              // plain text
const GROQ_VISION_MODEL = 'qwen/qwen3.8-27b';  // images
const GROQ_WHISPER_MODEL = 'whisper-large-v3';                              // audio/video transcription

app.use(cors());
app.use(express.json({ limit: '30mb' })); // raised from 20mb — voice/video messages base64-encode larger than screenshots

/* ------------------------------------------------------------------ */
/* STATIC FRONTEND                                                      */
/* ------------------------------------------------------------------ */
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Siteline-Groq.html'));
});

/* ------------------------------------------------------------------ */
/* STORAGE — simple JSON-file store (fine for a hackathon demo)         */
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
/* GROQ PROXY — text, image (vision model), audio/video (transcribed)   */
/* ------------------------------------------------------------------ */

// Rough filename-by-mimetype so Groq's transcription endpoint has a
// recognizable extension to key off of.
function filenameForMime(mime) {
  const map = {
    'audio/mpeg': 'audio.mp3',
    'audio/mp3': 'audio.mp3',
    'audio/wav': 'audio.wav',
    'audio/x-wav': 'audio.wav',
    'audio/mp4': 'audio.m4a',
    'audio/x-m4a': 'audio.m4a',
    'audio/aac': 'audio.aac',
    'audio/ogg': 'audio.ogg',
    'audio/webm': 'audio.webm',
    'audio/flac': 'audio.flac',
    'video/mp4': 'video.mp4',
    'video/webm': 'video.webm',
    'video/quicktime': 'video.mov'
  };
  return map[mime] || 'file.bin';
}

// Sends the raw audio/video bytes to Groq's Whisper transcription endpoint
// and returns the transcribed text. Groq's transcription endpoint accepts
// mp4/webm containers directly and just uses the audio track — so this
// same function covers both voice messages and video files. It captures
// spoken words only; it does not "see" anything in a video's picture.
async function transcribeMedia(base64Data, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');
  const blob = new Blob([buffer], { type: mimeType });

  const form = new FormData();
  form.append('file', blob, filenameForMime(mimeType));
  form.append('model', GROQ_WHISPER_MODEL);
  form.append('response_format', 'json');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Groq transcription error:', JSON.stringify(data, null, 2));
    throw new Error(data?.error?.message || 'Audio/video transcription failed.');
  }

  return data.text || '';
}

// Converts the Claude-style content blocks the frontend sends into
// whatever shape Groq's chat completions endpoint needs, picking the
// right model along the way. Returns { model, messageContent }.
async function buildGroqRequest(content) {
  // Plain string prompt — no attachment. Groq's text models want a
  // plain string here, not an array (this is what caused the earlier
  // "messages[0].content must be a string" error).
  if (typeof content === 'string') {
    return { model: GROQ_TEXT_MODEL, messageContent: content };
  }

  if (!Array.isArray(content)) {
    throw new Error('Invalid content format. Expected text or content blocks.');
  }

  const textParts = [];
  const imageParts = [];
  let transcript = null;

  for (const block of content) {
    if (!block) continue;

    if (block.type === 'text') {
      textParts.push(block.text || '');
      continue;
    }

    if (block.type === 'image') {
      if (!block.source?.data || !block.source?.media_type) {
        throw new Error('Invalid image attachment.');
      }
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
      });
      continue;
    }

    if (block.type === 'audio' || block.type === 'video') {
      if (!block.source?.data || !block.source?.media_type) {
        throw new Error(`Invalid ${block.type} attachment.`);
      }
      transcript = await transcribeMedia(block.source.data, block.source.media_type);
      continue;
    }

    if (block.type === 'document') {
      throw new Error('PDF attachments aren\'t supported yet. Try converting the page to an image (screenshot) and attaching that instead.');
    }
  }

  let combinedText = textParts.join('\n');
  if (transcript) {
    combinedText = `[Transcribed audio — visual content, if any, was not analyzed]:\n${transcript}\n\n${combinedText}`;
  }

  if (imageParts.length > 0) {
    // Vision model, multipart content.
    return {
      model: GROQ_VISION_MODEL,
      messageContent: [{ type: 'text', text: combinedText }, ...imageParts]
    };
  }

  // Text model, plain string content (covers text-only and
  // audio/video-transcribed-then-merged-into-text cases).
  return { model: GROQ_TEXT_MODEL, messageContent: combinedText };
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    provider: 'Groq',
    models: { text: GROQ_TEXT_MODEL, vision: GROQ_VISION_MODEL, whisper: GROQ_WHISPER_MODEL }
  });
});

app.post('/api/groq', async (req, res) => {
  try {
    const { content, maxTokens } = req.body;

    if (!content) {
      return res.status(400).json({
        error: { message: 'Missing content in request.' }
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: { message: 'GROQ_API_KEY is missing from the .env file.' }
      });
    }

    const { model, messageContent } = await buildGroqRequest(content);

    const isVision = model === GROQ_VISION_MODEL;

    const body = {
      model,
      messages: [{ role: 'user', content: messageContent }],
      max_tokens: Number(maxTokens) || 1000
    };
    // Structured JSON output mode isn't reliably supported on the vision
    // model — only request it for the text model, where your prompts
    // already ask explicitly for JSON.
    if (!isVision) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    console.log('Groq status:', response.status, '| model:', model);

    if (!response.ok) {
      console.error('Groq API error:', JSON.stringify(data, null, 2));
      return res.status(response.status).json(data);
    }

    const text = data.choices?.[0]?.message?.content || '';

    if (!text) {
      return res.status(502).json({
        error: { message: 'Groq returned an empty response.' },
        raw: data
      });
    }

    // Same Claude-compatible shape as before, so the existing SiteLine parser keeps working.
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
  console.log(`Models — text: ${GROQ_TEXT_MODEL} | vision: ${GROQ_VISION_MODEL} | whisper: ${GROQ_WHISPER_MODEL}`);
  console.log(`Storage file: ${DATA_FILE}`);
});