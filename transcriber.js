const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');

const CACHE_DIR = path.join(os.tmpdir(), 'stremio_chunk_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// In-memory mutex to prevent concurrent processing of the same chunk
const processingLocks = new Map();

async function downloadChunk(url, destPath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
  });
  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outputPath
    ]);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('Audio extraction failed'));
    });
  });
}

async function burnSubtitles(inputVideo, subtitleText, outputPath) {
  return new Promise((resolve, reject) => {
    const subFile = outputPath + '.txt';
    fs.writeFileSync(subFile, subtitleText || ' ', 'utf-8');
    const escapedSubFile = subFile.replace(/\\/g, '/').replace(/:/g, '\\:');

    const fontOption = fs.existsSync('/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf')
      ? "fontfile='/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf':"
      : "";

    const proc = spawn('ffmpeg', [
      '-y',
      '-i', inputVideo,
      '-vf', `drawtext=${fontOption}textfile='${escapedSubFile}':fontcolor=white:fontsize=26:box=1:boxcolor=black@0.65:boxborderw=6:x=(w-text_w)/2:y=h-text_h-35`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-c:a', 'copy',
      outputPath
    ]);

    proc.on('close', code => {
      try { fs.unlinkSync(subFile); } catch (e) {}
      if (code === 0) resolve();
      else reject(new Error('Subtitle burn failed'));
    });
  });
}

async function processChunkAndBurnSubtitles(chunkUrl, lang, apiKey) {
  const chunkHash = crypto.createHash('md5').update(chunkUrl + lang).digest('hex');
  const finalChunkPath = path.join(CACHE_DIR, `${chunkHash}.ts`);

  if (fs.existsSync(finalChunkPath)) {
    return finalChunkPath;
  }

  // Prevent multiple simultaneous processing of the same chunk
  if (processingLocks.has(chunkHash)) {
    return processingLocks.get(chunkHash);
  }

  const promise = (async () => {
    const rawPath = path.join(CACHE_DIR, `${chunkHash}_raw.ts`);
    const audioPath = path.join(CACHE_DIR, `${chunkHash}.wav`);
    
    try {
      await downloadChunk(chunkUrl, rawPath);
      await extractAudio(rawPath, audioPath);

      let text = '';
      if (apiKey && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(audioPath));
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('response_format', 'json');
        formData.append('temperature', '0.0');

        const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
          headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${apiKey}` },
          timeout: 8000
        });

        text = response.data.text || '';

        // Translate if necessary
        if (text && lang !== 'eng' && lang !== 'orig') {
           const targetLanguage = lang === 'fre' ? 'French' : lang === 'spa' ? 'Spanish' : lang === 'ger' ? 'German' : lang === 'ita' ? 'Italian' : 'English';
           const prompt = `Translate the following sports commentary line into ${targetLanguage}. If it is already in ${targetLanguage}, just keep it as is. Output ONLY the translation without any quotes, notes, or explanations:\n\n"${text}"`;
           const trRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
             model: 'llama-3.1-8b-instant',
             messages: [{ role: 'user', content: prompt }],
             temperature: 0.1,
             max_tokens: 120
           }, {
             headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
             timeout: 3500
           });
           text = trRes.data.choices[0]?.message?.content?.replace(/^["']|["']$/g, '').trim() || text;
        }
      }

      await burnSubtitles(rawPath, text, finalChunkPath);
      return finalChunkPath;
    } catch (e) {
      console.error('[Transcriber] Chunk error:', e.message);
      return null;
    } finally {
      try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch (e) {}
      try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch (e) {}
      processingLocks.delete(chunkHash);
    }
  })();

  processingLocks.set(chunkHash, promise);
  return promise;
}

// Cleanup old chunks every hour
setInterval(() => {
  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 3600000) { // older than 1 hour
        fs.unlinkSync(filePath);
      }
    });
  }
}, 3600000);

module.exports = {
  processChunkAndBurnSubtitles
};
