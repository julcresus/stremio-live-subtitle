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
  { code: 'orig', label: '🎙️ Original Audio (Live Speech)' },
  { code: 'eng', label: '🇬🇧 English (Live AI Translation)' },
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

// Proxy sports list from upstream
app.get('/sports.json', async (req, res) => {
  try {
    const response = await axios.get(`${HIGHFLY_BASE}/sports.json`);
    res.json(response.data);
  } catch (err) {
    res.json([
      { id: 'football', name: 'Football' },
      { id: 'basketball', name: 'Basketball' },
      { id: 'fight', name: 'Fight (UFC, Boxing)' },
      { id: 'motorsports', name: 'Motor Sports' },
      { id: 'tennis', name: 'Tennis' },
      { id: 'american-football', name: 'American Football' },
      { id: 'hockey', name: 'Hockey' },
      { id: 'baseball', name: 'Baseball' },
      { id: 'rugby', name: 'Rugby' },
      { id: 'cricket', name: 'Cricket' },
      { id: 'golf', name: 'Golf' },
      { id: 'billiards', name: 'Billiards' },
      { id: 'afl', name: 'AFL' },
      { id: 'darts', name: 'Darts' },
      { id: 'other', name: 'Other' }
    ]);
  }
});

// -------------------------------------------------------------
// Interactive Configuration Page (/ & /configure)
// -------------------------------------------------------------
app.get(['/', '/configure'], (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Configure Sports Streams + Live Subtitles</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  background:#1c1f26;
  color:#c8cdd8;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
  min-height:100vh;
  display:flex;
  justify-content:center;
  padding:0 20px;
}
.page{
  width:100%;
  max-width:400px;
  padding:44px 0 80px;
}
.app-name{
  font-size:22px;
  font-weight:700;
  color:#eef0f5;
  letter-spacing:-0.3px;
  display:flex;
  align-items:center;
  gap:8px;
}
.app-sub{
  margin-top:8px;
  font-size:13px;
  color:#6b7280;
  line-height:1.5;
}
section{margin-top:32px}
.sec-label{
  font-size:10px;
  font-weight:600;
  letter-spacing:1.8px;
  text-transform:uppercase;
  color:#4b5563;
  margin-bottom:12px;
}
.sec-hint{
  font-size:12.5px;
  color:#6b7280;
  margin-bottom:14px;
  line-height:1.5;
}
.pill-grid{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
}
.pill{
  padding:8px 14px;
  background:#252831;
  color:#9ca3af;
  font-size:12.5px;
  font-weight:500;
  border-radius:100px;
  cursor:pointer;
  user-select:none;
  transition:background .15s,color .15s;
}
.pill.selected{
  background:#1e3a5f;
  color:#60a5fa;
  border:1px solid #3b82f6;
}
.toggle-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:12px 0;
  border-bottom:1px solid #252831;
}
.toggle-label{
  font-size:13.5px;
  color:#c8cdd8;
  font-weight:500;
}
.toggle-sub{
  font-size:11.5px;
  color:#6b7280;
  margin-top:2px;
}
.toggle{
  position:relative;
  width:44px;
  height:24px;
  flex-shrink:0;
}
.toggle input{
  opacity:0;
  width:0;
  height:0;
  position:absolute;
}
.toggle-track{
  position:absolute;
  inset:0;
  background:#2d3140;
  border-radius:100px;
  cursor:pointer;
  transition:background .15s;
}
.toggle input:checked + .toggle-track{
  background:#2563eb;
}
.toggle-thumb{
  position:absolute;
  top:3px;
  left:3px;
  width:18px;
  height:18px;
  background:#fff;
  border-radius:50%;
  transition:transform .15s;
  pointer-events:none;
}
.toggle input:checked ~ .toggle-thumb{
  transform:translateX(20px);
}
.ai-badge{
  display:inline-block;
  background:rgba(37,99,235,0.2);
  color:#60a5fa;
  padding:3px 8px;
  border-radius:6px;
  font-size:11px;
  font-weight:600;
  margin-top:12px;
}
.install-area{margin-top:36px}
.install-btn{
  display:block;
  width:100%;
  padding:14px;
  background:#2563eb;
  color:#fff;
  font-size:14px;
  font-weight:600;
  font-family:inherit;
  text-align:center;
  border-radius:10px;
  border:none;
  cursor:pointer;
  transition:background .15s;
  text-decoration:none;
}
.install-btn:hover{background:#1d4ed8}
.web-btn{
  display:block;
  width:100%;
  padding:14px;
  background:#252831;
  color:#eef0f5;
  font-size:14px;
  font-weight:600;
  font-family:inherit;
  text-align:center;
  border-radius:10px;
  border:none;
  cursor:pointer;
  margin-top:10px;
  transition:background .15s;
  text-decoration:none;
}
.web-btn:hover{background:#2d3140}
.link-row{
  margin-top:16px;
  display:flex;
  align-items:center;
  gap:10px;
}
.link-url{
  flex:1;
  font-size:11px;
  color:#6b7280;
  word-break:break-all;
  line-height:1.5;
  font-family:monospace;
  background:#14171e;
  padding:8px 10px;
  border-radius:6px;
}
.copy-btn{
  background:#252831;
  border:none;
  color:#c8cdd8;
  font-size:12px;
  font-weight:600;
  font-family:inherit;
  cursor:pointer;
  padding:8px 12px;
  border-radius:6px;
  white-space:nowrap;
  transition:background .15s;
}
.copy-btn:hover{background:#2d3140}
.status-msg{margin-top:6px;font-size:11px;color:#4ade80;text-align:center;min-height:16px}
</style>
</head>
<body>
<div class="page">

  <div class="app-name">🎙️ Sports Streams</div>
  <div class="app-sub">Filter what appears in your catalogs. Settings are saved in the addon URL. Reinstall to apply.</div>
  <div class="ai-badge">✨ Real-Time AI Subtitles & Multi-Language Translation Enabled</div>

  <section>
    <div class="sec-label">Preferences</div>
    <div class="toggle-row">
      <div>
        <div class="toggle-label">Live matches only</div>
        <div class="toggle-sub">Hide scheduled matches, show only what is live right now.</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="onlyLiveToggle">
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
      </label>
    </div>
    <div class="toggle-row">
      <div>
        <div class="toggle-label">Hide titles</div>
        <div class="toggle-sub">Show posters only. Titles are hidden on catalog cards.</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="hideTitlesToggle">
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
      </label>
    </div>
    <div class="toggle-row">
      <div>
        <div class="toggle-label">Hide descriptions</div>
        <div class="toggle-sub">Hide the description text under catalog cards.</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="hideDescToggle">
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
      </label>
    </div>
  </section>

  <section>
    <div class="sec-label">Sports</div>
    <div class="sec-hint">Tap sports to show only those in your catalogs. Tap again to deselect. If none selected, all sports are shown.</div>
    <div class="pill-grid" id="sportGrid"></div>
  </section>

  <div class="install-area">
    <button class="install-btn" id="installBtn">Install in Stremio</button>
    <button class="web-btn" id="webBtn">Add to Stremio Web</button>
    <div class="link-row">
      <div class="link-url" id="linkUrl"></div>
      <button class="copy-btn" id="copyBtn">Copy</button>
    </div>
    <div class="status-msg" id="statusMsg"></div>
  </div>

</div>

<script>
let allSports = [];
let inclSports = new Set();
let onlyLive = false;
let hideTitles = false;
let hideDesc = false;

// Prepopulate from URL hash if reconfiguring
try {
  const h = location.hash.slice(1);
  if (h) {
    let b = h.replace(/-/g,'+').replace(/_/g,'/');
    while (b.length % 4) b += '=';
    const c = JSON.parse(atob(b));
    (c.includeSports || []).forEach(s => inclSports.add(s));
    onlyLive = !!c.onlyLive;
    hideTitles = !!c.hideTitles;
    hideDesc = !!c.hideDescriptions;
  }
} catch(e) {}

document.getElementById('onlyLiveToggle').checked = onlyLive;
document.getElementById('onlyLiveToggle').addEventListener('change', e => {
  onlyLive = e.target.checked;
  updateUrl();
});

document.getElementById('hideTitlesToggle').checked = hideTitles;
document.getElementById('hideTitlesToggle').addEventListener('change', e => {
  hideTitles = e.target.checked;
  updateUrl();
});

document.getElementById('hideDescToggle').checked = hideDesc;
document.getElementById('hideDescToggle').addEventListener('change', e => {
  hideDesc = e.target.checked;
  updateUrl();
});

async function loadSports() {
  try {
    const res = await fetch('/sports.json');
    allSports = await res.json();
  } catch(e) {
    allSports = [
      { id: 'football', name: 'Football' },
      { id: 'basketball', name: 'Basketball' },
      { id: 'fight', name: 'Fight (UFC, Boxing)' },
      { id: 'motorsports', name: 'Motor Sports' },
      { id: 'tennis', name: 'Tennis' },
      { id: 'american-football', name: 'American Football' },
      { id: 'hockey', name: 'Hockey' },
      { id: 'baseball', name: 'Baseball' },
      { id: 'rugby', name: 'Rugby' },
      { id: 'cricket', name: 'Cricket' },
      { id: 'golf', name: 'Golf' },
      { id: 'billiards', name: 'Billiards' },
      { id: 'afl', name: 'AFL' },
      { id: 'darts', name: 'Darts' },
      { id: 'other', name: 'Other' }
    ];
  }
  renderSports();
}

function renderSports() {
  const grid = document.getElementById('sportGrid');
  grid.innerHTML = '';
  allSports.forEach(s => {
    const el = document.createElement('div');
    el.className = 'pill' + (inclSports.has(s.id) ? ' selected' : '');
    el.textContent = s.name;
    el.addEventListener('click', () => {
      if (inclSports.has(s.id)) inclSports.delete(s.id);
      else inclSports.add(s.id);
      el.classList.toggle('selected');
      updateUrl();
    });
    grid.appendChild(el);
  });
}

function buildConfig() {
  const c = {};
  if (inclSports.size) c.includeSports = [...inclSports];
  if (onlyLive) c.onlyLive = true;
  if (hideTitles) c.hideTitles = true;
  if (hideDesc) c.hideDescriptions = true;
  return c;
}

function encodeConfig(c) {
  if (!Object.keys(c).length) return '';
  return btoa(JSON.stringify(c)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
}

function getManifestUrl() {
  const enc = encodeConfig(buildConfig());
  const origin = window.location.origin;
  return enc ? origin + '/' + enc + '/manifest.json' : origin + '/manifest.json';
}

function updateUrl() {
  document.getElementById('linkUrl').textContent = getManifestUrl();
}

document.getElementById('installBtn').addEventListener('click', () => {
  window.open(getManifestUrl().replace(/^https?:\\/\\//, 'stremio://'), '_blank');
});

document.getElementById('webBtn').addEventListener('click', () => {
  window.open('https://web.stremio.com/#/addons?addon=' + encodeURIComponent(getManifestUrl()), '_blank');
});

document.getElementById('copyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(getManifestUrl()).then(() => {
    const msg = document.getElementById('statusMsg');
    msg.textContent = 'Copied to clipboard!';
    setTimeout(() => msg.textContent = '', 2000);
  });
});

loadSports();
updateUrl();
</script>
</body>
</html>
  `);
});

// -------------------------------------------------------------
// Universal Upstream Path Resolver
// -------------------------------------------------------------
function getUpstreamUrl(req) {
  return `${HIGHFLY_BASE}${req.path}`;
}

// 1. Manifest Handler
app.get(['/manifest.json', '*/manifest.json'], async (req, res) => {
  try {
    const upstreamUrl = getUpstreamUrl(req);
    const response = await axios.get(upstreamUrl);
    const manifest = response.data;
    
    manifest.id = 'community.sports.live_ai_subtitles';
    manifest.name = 'Sports Streams (Live Subtitles)';
    manifest.description = 'Live sports streams with real-time AI commentary subtitles & translation.';
    manifest.logo = 'https://cdn-icons-png.flaticon.com/512/860/860330.png';
    
    manifest.behaviorHints = {
      configurable: true,
      configurationRequired: false
    };

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

// 2. Catalog Proxy
app.get(['/catalog/*', '*/catalog/*'], async (req, res) => {
  try {
    const upstreamUrl = getUpstreamUrl(req);
    const response = await axios.get(upstreamUrl);
    res.json(response.data);
  } catch (error) {
    console.error(`[Addon] Catalog error (${req.path}):`, error.message);
    res.status(500).json({ metas: [] });
  }
});

// 3. Meta Proxy
app.get(['/meta/*', '*/meta/*'], async (req, res) => {
  try {
    const upstreamUrl = getUpstreamUrl(req);
    const response = await axios.get(upstreamUrl);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ meta: null });
  }
});

// 4. Stream Proxy
app.get(['/stream/*', '*/stream/*'], async (req, res) => {
  const host = getHostUrl(req);
  try {
    const upstreamUrl = getUpstreamUrl(req);
    const response = await axios.get(upstreamUrl);
    const data = response.data;

    if (data && data.streams && Array.isArray(data.streams)) {
      data.streams = data.streams.map((stream) => {
        if (stream.url) {
          const streamHash = crypto.createHash('md5').update(stream.url).digest('hex').substring(0, 10);
          const encodedStreamUrl = encodeURIComponent(Buffer.from(stream.url).toString('base64'));
          
          getOrCreateSession(stream.url, streamHash, GROQ_API_KEY);
          const subtitleTracks = buildSubtitleTracks(host, encodedStreamUrl, streamHash);

          return {
            ...stream,
            url: stream.url,
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

// 5. Subtitles Resource Endpoint
app.get(['/subtitles/sport/*', '*/subtitles/sport/*'], async (req, res) => {
  const host = getHostUrl(req);
  try {
    const streamPath = req.path.replace(/.*\/subtitles\//, '/stream/');
    const upstreamUrl = `${HIGHFLY_BASE}${streamPath}`;
    const streamRes = await axios.get(upstreamUrl);
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
// HLS Continuous Master & Subtitle Playlist Endpoints
// -------------------------------------------------------------

// HLS Master Playlist (Directs video to source + connects continuous live subtitle tracks)
app.get('/hls/:encodedUrl/master.m3u8', (req, res) => {
  const { encodedUrl } = req.params;
  const host = getHostUrl(req);
  let rawUrl;
  try {
    rawUrl = Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).send('Invalid stream URL encoding');
  }

  const streamId = crypto.createHash('md5').update(rawUrl).digest('hex').substring(0, 10);
  getOrCreateSession(rawUrl, streamId, GROQ_API_KEY);

  let master = `#EXTM3U\n#EXT-X-VERSION:3\n`;
  master += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="🎙️ English AI",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="eng",URI="${host}/hls/${encodedUrl}/sub_eng.m3u8"\n`;
  master += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="🇫🇷 Français AI",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="fre",URI="${host}/hls/${encodedUrl}/sub_fre.m3u8"\n`;
  master += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="🇪🇸 Español AI",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="spa",URI="${host}/hls/${encodedUrl}/sub_spa.m3u8"\n`;
  master += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="🇩🇪 Deutsch AI",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="ger",URI="${host}/hls/${encodedUrl}/sub_ger.m3u8"\n`;
  master += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="🇮🇹 Italiano AI",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="ita",URI="${host}/hls/${encodedUrl}/sub_ita.m3u8"\n`;
  master += `#EXT-X-STREAM-INF:BANDWIDTH=3000000,SUBTITLES="subs"\n`;
  master += `${rawUrl}\n`;

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(master);
});

// Continuous Rolling HLS Subtitle Playlist (.m3u8)
app.get('/hls/:encodedUrl/sub_:lang.m3u8', (req, res) => {
  const { encodedUrl, lang } = req.params;
  const host = getHostUrl(req);
  let rawUrl;
  try {
    rawUrl = Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).send('Invalid stream URL encoding');
  }

  const streamId = crypto.createHash('md5').update(rawUrl).digest('hex').substring(0, 10);
  const session = getOrCreateSession(rawUrl, streamId, GROQ_API_KEY);

  const playlist = session.getHlsSubtitlePlaylist(host, encodedUrl, lang || 'eng');

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(playlist);
});

// HLS Subtitle Segment Chunk (.vtt)
app.get('/hls/:encodedUrl/seg_:segId_:lang.vtt', (req, res) => {
  const { encodedUrl, segId, lang } = req.params;
  let rawUrl;
  try {
    rawUrl = Buffer.from(decodeURIComponent(encodedUrl), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).send('Invalid stream URL encoding');
  }

  const streamId = crypto.createHash('md5').update(rawUrl).digest('hex').substring(0, 10);
  const session = getOrCreateSession(rawUrl, streamId, GROQ_API_KEY);

  const vtt = session.getSegmentVTT(segId, lang || 'eng');

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(vtt);
});

// WebVTT Subtitles Endpoint (Direct standalone file)
app.get(['/subtitles/:encodedUrl/:lang/live.vtt', '/subtitles/:encodedUrl/live.vtt'], (req, res) => {
  const { encodedUrl, lang } = req.params;
  let rawUrl;
  try {
    const decoded = decodeURIComponent(encodedUrl);
    rawUrl = Buffer.from(decoded, 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).send('Invalid stream URL encoding');
  }

  const streamId = crypto.createHash('md5').update(rawUrl).digest('hex').substring(0, 10);
  const session = getOrCreateSession(rawUrl, streamId, GROQ_API_KEY);

  const vttContent = session.getWebVTT(lang || 'eng');

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(vttContent);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Stremio Sports Streams + AI Subtitles running on port ${PORT}`);
});
