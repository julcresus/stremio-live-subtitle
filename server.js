require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { getOrCreateSession } = require('./transcriber');

const app = express();
const PORT = process.env.PORT || 7000;
const HIGHFLY_BASE = 'https://sports.highfly.dev';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// Enable CORS for Stremio Web, Desktop and LG Smart TV apps
app.use(cors());

function getHostUrl(req) {
  if (process.env.HOST_URL) return process.env.HOST_URL.replace(/\/$/, '');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

const SUPPORTED_LANGUAGES = [
  { code: 'eng', label: '🎙️ Live English (Original)' },
  { code: 'fre', label: '🇫🇷 Français (Traduction AI)' },
  { code: 'spa', label: '🇪🇸 Español (Traducción AI)' },
  { code: 'ger', label: '🇩🇪 Deutsch (AI Übersetzung)' },
  { code: 'ita', label: '🇮🇹 Italiano (Traduzione AI)' }
];

function buildSubtitleTracks(host, encodedStreamUrl, streamHash) {
  return SUPPORTED_LANGUAGES.map(lang => ({
    id: `live-sub-${streamHash}-${lang.code}`,
    lang: lang.code,
    url: `${host}/subtitles/${encodedStreamUrl}/${lang.code}/live.vtt`,
    label: lang.label
  }));
}

// -------------------------------------------------------------
// Landing Page with 1-Click Install Options
// -------------------------------------------------------------
app.get('/', (req, res) => {
  const host = getHostUrl(req);
  const cleanHost = host.replace(/^https?:\/\//, '');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>Live Sports AI Subtitles & Translation for Stremio</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; box-sizing: border-box; }
          .container { background: #161f30; padding: 36px; border-radius: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.6); max-width: 580px; width: 100%; border: 1px solid #1e293b; text-align: center; }
          h1 { color: #38bdf8; margin: 0 0 10px; font-size: 26px; }
          p { color: #94a3b8; line-height: 1.6; font-size: 15px; margin-bottom: 24px; }
          .addon-card { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: left; }
          .addon-card h3 { margin: 0 0 6px; color: #e2e8f0; font-size: 17px; }
          .addon-card p { margin: 0 0 14px; font-size: 13px; color: #64748b; }
          .btn { display: inline-block; background: #0284c7; color: #fff; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; transition: all 0.2s; }
          .btn:hover { background: #0369a1; transform: translateY(-1px); }
          .status { margin-top: 16px; font-size: 13px; color: ${GROQ_API_KEY ? '#4ade80' : '#f87171'}; }
          .url-box { background: #0b0f19; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 12px; color: #94a3b8; word-break: break-all; margin-top: 10px; }
          .flags { margin: 12px 0 0; font-size: 14px; color: #cbd5e1; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎙️ Live Sports AI Subtitles & Translation</h1>
          <p>Real-time speech-to-text live commentary subtitles + multilingual live translation on LG TV, Mac, and Mobile.</p>
          
          <div class="addon-card">
            <h3>Live Sports (AI Subtitles & Translations)</h3>
            <p>Live sports matches with continuous real-time subtitles and instant translation into English, French, Spanish, German, and Italian.</p>
            <a class="btn" href="stremio://${cleanHost}/manifest.json">Install Add-on to Stremio</a>
            <div class="flags">Languages: 🎙️ English · 🇫🇷 Français · 🇪🇸 Español · 🇩🇪 Deutsch · 🇮🇹 Italiano</div>
            <div class="url-box">${host}/manifest.json</div>
          </div>

          <div class="status">● AI Engine: ${GROQ_API_KEY ? 'Active (Groq Whisper + Llama Translation)' : 'API Key Missing'}</div>
        </div>
      </body>
    </html>
  `);
});

// -------------------------------------------------------------
// 1. STANDALONE ADD-ON (Catalog + Meta + Streams + Subtitles)
// -------------------------------------------------------------

app.get('/manifest.json', async (req, res) => {
  try {
    const response = await axios.get(`${HIGHFLY_BASE}/manifest.json`);
    const manifest = response.data;
    
    manifest.id = 'community.sports.live_ai_subtitles';
    manifest.name = 'Live Sports (AI Subtitles)';
    manifest.description = 'Live sports matches with continuous real-time AI commentary subtitles and live translation.';
    manifest.logo = 'https://cdn-icons-png.flaticon.com/512/860/860330.png';
    
    manifest.catalogs = [
      {
        type: 'sport',
        id: 'sports_live',
        name: 'Live Sports (AI Subtitles)',
        extra: [{ name: 'skip', isRequired: false }]
      }
    ];

    manifest.resources = [
      { name: 'catalog', types: ['sport'] },
      { name: 'meta', types: ['sport'], idPrefixes: ['streamed', 'sf', 'recap', 'leaf'] },
      { name: 'stream', types: ['sport'], idPrefixes: ['streamed', 'sf', 'recap', 'leaf'] },
      { name: 'subtitles', types: ['sport'], idPrefixes: ['streamed', 'sf', 'recap', 'leaf'] }
    ];

    res.json(manifest);
  } catch (error) {
    console.error('[Addon] Manifest error:', error.message);
    res.status(500).json({ error: 'Failed to load upstream manifest' });
  }
});

// Catalog Proxy
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type, id, extra } = req.params;
  const upstreamUrl = extra 
    ? `${HIGHFLY_BASE}/catalog/${type}/${id}/${extra}.json`
    : `${HIGHFLY_BASE}/catalog/${type}/${id}.json`;

  try {
    const response = await axios.get(upstreamUrl);
    res.json(response.data);
  } catch (error) {
    console.error(`[Addon] Catalog error:`, error.message);
    res.status(500).json({ metas: [] });
  }
});

// Meta Proxy
app.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  try {
    const response = await axios.get(`${HIGHFLY_BASE}/meta/${type}/${id}.json`);
    res.json(response.data);
  } catch (error) {
    console.error(`[Addon] Meta error:`, error.message);
    res.status(500).json({ meta: null });
  }
});

// Stream Proxy with Pre-Warming and Subtitle Tracks
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const host = getHostUrl(req);

  try {
    const response = await axios.get(`${HIGHFLY_BASE}/stream/${type}/${id}.json`);
    const data = response.data;

    if (data && data.streams && Array.isArray(data.streams)) {
      data.streams = data.streams.map((stream, idx) => {
        if (stream.url) {
          const streamHash = crypto.createHash('md5').update(stream.url).digest('hex').substring(0, 10);
          const encodedStreamUrl = encodeURIComponent(Buffer.from(stream.url).toString('base64'));
          
          // Pre-warm the audio transcription session immediately
          if (idx === 0) {
            getOrCreateSession(stream.url, streamHash, GROQ_API_KEY);
          }

          const subtitleTracks = buildSubtitleTracks(host, encodedStreamUrl, streamHash);

          return {
            ...stream,
            title: `🎙️ ${stream.title || 'Live Stream'} [AI Subtitles & Translations]`,
            subtitles: subtitleTracks
          };
        }
        return stream;
      });
    }

    res.json(data);
  } catch (error) {
    console.error(`[Addon] Stream error:`, error.message);
    res.status(500).json({ streams: [] });
  }
});

// Standalone Subtitles Resource Endpoint
app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  const host = getHostUrl(req);

  try {
    const streamRes = await axios.get(`${HIGHFLY_BASE}/stream/${type}/${id}.json`);
    const streams = streamRes.data?.streams || [];
    
    let subtitles = [];
    if (streams.length > 0 && streams[0].url) {
      const streamUrl = streams[0].url;
      const streamHash = crypto.createHash('md5').update(streamUrl).digest('hex').substring(0, 10);
      const encodedStreamUrl = encodeURIComponent(Buffer.from(streamUrl).toString('base64'));
      
      getOrCreateSession(streamUrl, streamHash, GROQ_API_KEY);
      subtitles = buildSubtitleTracks(host, encodedStreamUrl, streamHash);
    }

    res.json({ subtitles });
  } catch (error) {
    res.json({ subtitles: [] });
  }
});

// -------------------------------------------------------------
// 2. CONTINUOUS STREAMING WEBVTT ENDPOINT
// -------------------------------------------------------------

app.get('/subtitles/:encodedUrl/:lang/live.vtt', (req, res) => {
  const { encodedUrl, lang } = req.params;
  let rawUrl;
  try {
    rawUrl = Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).send('Invalid stream URL encoding');
  }

  const streamId = crypto.createHash('md5').update(rawUrl).digest('hex').substring(0, 10);
  const session = getOrCreateSession(rawUrl, streamId, GROQ_API_KEY);

  // Attach client as an active streaming listener to continuously receive live cues & translation
  session.attachListener(res, lang || 'eng');
});

// Backward-compatible route without lang parameter (defaults to English)
app.get('/subtitles/:encodedUrl/live.vtt', (req, res) => {
  const { encodedUrl } = req.params;
  let rawUrl;
  try {
    rawUrl = Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).send('Invalid stream URL encoding');
  }

  const streamId = crypto.createHash('md5').update(rawUrl).digest('hex').substring(0, 10);
  const session = getOrCreateSession(rawUrl, streamId, GROQ_API_KEY);

  session.attachListener(res, 'eng');
});

app.listen(PORT, () => {
  console.log(`\n🚀 Stremio Live Subtitles & Translation Addon running on port ${PORT}`);
});
