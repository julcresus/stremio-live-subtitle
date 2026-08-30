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

// Enable CORS for all Stremio web clients and smart TVs
app.use(cors());

// Health / Status check
app.get('/', (req, res) => {
  const host = getHostUrl(req);
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Sports Streams (Live Subtitles)</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
          .card { background: #1e293b; padding: 32px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 550px; text-align: center; }
          h1 { color: #38bdf8; margin-bottom: 12px; }
          p { color: #94a3b8; line-height: 1.6; }
          .btn { display: inline-block; background: #0284c7; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px; margin-top: 20px; transition: background 0.2s; }
          .btn:hover { background: #0369a1; }
          .status { margin-top: 20px; font-size: 14px; color: ${GROQ_API_KEY ? '#4ade80' : '#f87171'}; }
          .code { background: #0f172a; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; word-break: break-all; margin-top: 16px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Sports Streams + Live Subtitles</h1>
          <p>Cloud-hosted Stremio Add-on that injects real-time AI live subtitles into sports streams.</p>
          <a class="btn" href="stremio://${host.replace(/^https?:\/\//, '')}/manifest.json">Install to Stremio</a>
          <div class="status">● AI Engine Status: ${GROQ_API_KEY ? 'Active (Groq Whisper)' : 'API Key Missing (Set GROQ_API_KEY)'}</div>
          <div class="code">Manifest URL: ${host}/manifest.json</div>
        </div>
      </body>
    </html>
  `);
});

function getHostUrl(req) {
  if (process.env.HOST_URL) return process.env.HOST_URL.replace(/\/$/, '');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}

// 1. Manifest
app.get('/manifest.json', async (req, res) => {
  try {
    const response = await axios.get(`${HIGHFLY_BASE}/manifest.json`);
    const manifest = response.data;
    
    // Customize addon branding
    manifest.id = 'community.sports.live_subtitles';
    manifest.name = 'Sports Streams (Live Subtitles)';
    manifest.description = 'Live sports streams with real-time AI commentary subtitles for LG TV and all devices.';
    
    // Ensure subtitles resource is registered
    if (!manifest.resources.includes('subtitles')) {
      manifest.resources.push({
        name: 'subtitles',
        types: ['sport'],
        idPrefixes: ['streamed', 'sf', 'recap', 'leaf']
      });
    }

    res.json(manifest);
  } catch (error) {
    console.error('[Addon] Manifest error:', error.message);
    res.status(500).json({ error: 'Failed to load upstream manifest' });
  }
});

// 2. Catalog proxy
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type, id, extra } = req.params;
  const upstreamUrl = extra 
    ? `${HIGHFLY_BASE}/catalog/${type}/${id}/${extra}.json`
    : `${HIGHFLY_BASE}/catalog/${type}/${id}.json`;

  try {
    const response = await axios.get(upstreamUrl);
    res.json(response.data);
  } catch (error) {
    console.error(`[Addon] Catalog error (${upstreamUrl}):`, error.message);
    res.status(500).json({ metas: [] });
  }
});

// 3. Meta proxy
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

// 4. Stream proxy & Subtitle Injection
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const host = getHostUrl(req);

  try {
    const response = await axios.get(`${HIGHFLY_BASE}/stream/${type}/${id}.json`);
    const data = response.data;

    if (data && data.streams && Array.isArray(data.streams)) {
      data.streams = data.streams.map((stream) => {
        if (stream.url) {
          const streamHash = crypto.createHash('md5').update(stream.url).digest('hex').substring(0, 10);
          const encodedStreamUrl = encodeURIComponent(Buffer.from(stream.url).toString('base64'));
          
          const subtitleTrack = {
            id: `live-sub-${streamHash}`,
            lang: 'eng',
            url: `${host}/subtitles/${encodedStreamUrl}/live.vtt`,
            label: '🎙️ Live AI Subtitles'
          };

          return {
            ...stream,
            title: `${stream.title || 'Stream'} [🎙️ Live Captions]`,
            subtitles: [subtitleTrack]
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

// 5. Stremio Subtitles Resource Endpoint (Queries subtitles for a match/video)
app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  const host = getHostUrl(req);

  try {
    // Fetch stream URLs for this match to link the live subtitle track
    const streamRes = await axios.get(`${HIGHFLY_BASE}/stream/${type}/${id}.json`);
    const streams = streamRes.data?.streams || [];
    
    const subtitles = [];
    if (streams.length > 0 && streams[0].url) {
      const encodedStreamUrl = encodeURIComponent(Buffer.from(streams[0].url).toString('base64'));
      subtitles.push({
        id: `live-ai-${id}`,
        url: `${host}/subtitles/${encodedStreamUrl}/live.vtt`,
        lang: 'eng',
        label: '🎙️ Live AI Subtitles'
      });
    }

    res.json({ subtitles });
  } catch (error) {
    console.error(`[Addon] Subtitles resource error:`, error.message);
    res.json({ subtitles: [] });
  }
});

// 6. Dynamic WebVTT Live Subtitle Endpoint
app.get('/subtitles/:encodedUrl/live.vtt', (req, res) => {
  const { encodedUrl } = req.params;
  let rawUrl;
  try {
    rawUrl = Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).send('Invalid stream URL encoding');
  }

  const streamId = crypto.createHash('md5').update(rawUrl).digest('hex').substring(0, 12);
  const session = getOrCreateSession(rawUrl, streamId, GROQ_API_KEY);

  const vttContent = session.getWebVTT();

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(vttContent);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Stremio Live Subtitle Proxy listening on port ${PORT}`);
  console.log(`👉 Addon URL: http://localhost:${PORT}/manifest.json\n`);
});
