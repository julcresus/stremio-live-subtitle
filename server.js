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
        <title>Live Sports AI Subtitles for Stremio</title>
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
          .btn-secondary { background: #334155; }
          .btn-secondary:hover { background: #475569; }
          .status { margin-top: 16px; font-size: 13px; color: ${GROQ_API_KEY ? '#4ade80' : '#f87171'}; }
          .url-box { background: #0b0f19; padding: 10px; border-radius: 6px; font-family: monospace; font-size: 12px; color: #94a3b8; word-break: break-all; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎙️ Live Sports AI Subtitles</h1>
          <p>Real-time speech-to-text live commentary subtitles for sports streams on LG TV, Mac, and Mobile.</p>
          
          <div class="addon-card">
            <h3>Option 1: Standalone Live Sports Add-on (Recommended)</h3>
            <p>Provides a dedicated "Live Sports (AI Subtitles)" catalog with pre-configured live subtitle tracks on every match.</p>
            <a class="btn" href="stremio://${cleanHost}/manifest.json">Install Standalone Addon</a>
            <div class="url-box">${host}/manifest.json</div>
          </div>

          <div class="addon-card">
            <h3>Option 2: Universal Subtitle Provider Add-on</h3>
            <p>Injects real-time AI subtitles into any existing sports add-on already installed in your Stremio.</p>
            <a class="btn btn-secondary" href="stremio://${cleanHost}/subtitles-addon/manifest.json">Install Subtitle Provider</a>
            <div class="url-box">${host}/subtitles-addon/manifest.json</div>
          </div>

          <div class="status">● AI Engine: ${GROQ_API_KEY ? 'Active (Groq Whisper Turbo)' : 'API Key Missing (Set GROQ_API_KEY)'}</div>
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
    manifest.description = 'Standalone live sports matches with real-time AI commentary subtitles.';
    manifest.logo = 'https://cdn-icons-png.flaticon.com/512/860/860330.png';
    
    // Configure standalone catalog
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

// Stream Proxy with Pre-Warming and Subtitle Track Injection
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
          
          // Pre-warm the audio transcription session immediately when stream list is requested
          if (idx === 0) {
            getOrCreateSession(stream.url, streamHash, GROQ_API_KEY);
          }

          const subtitleUrl = `${host}/subtitles/${encodedStreamUrl}/live.vtt`;

          return {
            ...stream,
            title: `🎙️ ${stream.title || 'Live Stream'} (AI Subtitles)`,
            subtitles: [
              {
                id: `live-sub-${streamHash}`,
                lang: 'eng',
                url: subtitleUrl,
                label: '🎙️ Live AI Subtitles'
              }
            ]
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
    
    const subtitles = [];
    if (streams.length > 0 && streams[0].url) {
      const streamUrl = streams[0].url;
      const streamHash = crypto.createHash('md5').update(streamUrl).digest('hex').substring(0, 10);
      const encodedStreamUrl = encodeURIComponent(Buffer.from(streamUrl).toString('base64'));
      
      // Warm session
      getOrCreateSession(streamUrl, streamHash, GROQ_API_KEY);

      subtitles.push({
        id: `live-ai-${id}`,
        url: `${host}/subtitles/${encodedStreamUrl}/live.vtt`,
        lang: 'eng',
        label: '🎙️ Live AI Subtitles'
      });
    }

    res.json({ subtitles });
  } catch (error) {
    console.error(`[Addon] Subtitles error:`, error.message);
    res.json({ subtitles: [] });
  }
});

// -------------------------------------------------------------
// 2. UNIVERSAL SUBTITLES-ONLY ADD-ON
// -------------------------------------------------------------

app.get('/subtitles-addon/manifest.json', (req, res) => {
  res.json({
    id: 'org.stremio.live.sports.subtitles',
    version: '1.0.0',
    name: 'Live Sports AI Subtitles Provider',
    description: 'Provides real-time AI commentary subtitles for live sports channels in Stremio.',
    logo: 'https://cdn-icons-png.flaticon.com/512/860/860330.png',
    resources: [
      {
        name: 'subtitles',
        types: ['sport', 'tv', 'channel'],
        idPrefixes: ['streamed', 'sf', 'recap', 'leaf']
      }
    ],
    types: ['sport', 'tv', 'channel'],
    catalogs: []
  });
});

app.get('/subtitles-addon/subtitles/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  const host = getHostUrl(req);

  try {
    const streamRes = await axios.get(`${HIGHFLY_BASE}/stream/${type}/${id}.json`);
    const streams = streamRes.data?.streams || [];
    
    const subtitles = [];
    if (streams.length > 0 && streams[0].url) {
      const streamUrl = streams[0].url;
      const streamHash = crypto.createHash('md5').update(streamUrl).digest('hex').substring(0, 10);
      const encodedStreamUrl = encodeURIComponent(Buffer.from(streamUrl).toString('base64'));
      
      getOrCreateSession(streamUrl, streamHash, GROQ_API_KEY);

      subtitles.push({
        id: `live-sub-${streamHash}`,
        url: `${host}/subtitles/${encodedStreamUrl}/live.vtt`,
        lang: 'eng',
        label: '🎙️ Live AI Subtitles'
      });
    }

    res.json({ subtitles });
  } catch (error) {
    res.json({ subtitles: [] });
  }
});

// -------------------------------------------------------------
// 3. DYNAMIC WEBVTT SERVING
// -------------------------------------------------------------

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

  const vttContent = session.getWebVTT();

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(vttContent);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Stremio Live Subtitles Addon running on port ${PORT}`);
});
