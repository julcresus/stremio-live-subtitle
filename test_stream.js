const axios = require('axios');
const fs = require('fs');

async function test() {
  try {
    // 1. Get meta for football
    const catRes = await axios.get('http://localhost:7000/catalog/sport/football.json');
    const firstItem = catRes.data.metas[0];
    if (!firstItem) return console.log('No live matches found');
    
    // 2. Get streams for first match
    const streamRes = await axios.get(`http://localhost:7000/stream/sport/${firstItem.id}.json`);
    const streams = streamRes.data.streams;
    const aiStream = streams.find(s => s.name.includes('AI Subtitles'));
    
    if (!aiStream) return console.log('No AI stream found');
    
    console.log('Testing URL:', aiStream.url);
    
    // 3. Fetch the proxy playlist
    const m3u8Res = await axios.get(aiStream.url);
    const lines = m3u8Res.data.split('\n');
    let chunkUrl = null;
    
    for (const line of lines) {
      if (line.includes('/chunk/')) {
        chunkUrl = line;
        break;
      }
    }
    
    if (!chunkUrl) {
      // It might be a master playlist, so fetch the media playlist
      let mediaUrl = lines.find(l => l.includes('/live-video/') && l.endsWith('.m3u8'));
      if (mediaUrl) {
        console.log('Fetching media playlist:', mediaUrl);
        const mediaRes = await axios.get(mediaUrl);
        const mediaLines = mediaRes.data.split('\n');
        chunkUrl = mediaLines.find(l => l.includes('/chunk/'));
      }
    }
    
    if (!chunkUrl) return console.log('No chunk URL found in playlist');
    
    console.log('Fetching TS chunk (this will trigger Whisper and FFmpeg)...');
    console.log('Chunk URL:', chunkUrl);
    
    const startTime = Date.now();
    const chunkRes = await axios.get(chunkUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const duration = Date.now() - startTime;
    
    console.log(`Success! Chunk size: ${chunkRes.data.length} bytes. Processing took ${duration}ms`);
    
  } catch (err) {
    console.error('Test failed:', err.message);
    if (err.response) console.error('Response:', err.response.data.toString());
  }
}

test();
