const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');

// Store active transcription sessions: streamId -> Session
const sessions = new Map();

class StreamSession {
  constructor(streamUrl, streamId, apiKey) {
    this.streamUrl = streamUrl;
    this.streamId = streamId;
    this.apiKey = apiKey;
    this.cues = []; // { start: number, end: number, text: { [lang]: string } }
    this.listeners = new Set(); // Active HTTP response streams { res, lang }
    this.lastAccessTime = Date.now();
    this.startTime = Date.now();
    this.isAlive = true;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `sub_${streamId}_`));
    this.ffmpegProc = null;

    this.startAudioCapture();
  }

  touch() {
    this.lastAccessTime = Date.now();
  }

  startAudioCapture() {
    console.log(`[Transcriber] Starting live audio extraction for ${this.streamId}`);
    
    // Extract live audio into 3-second slices
    const segmentPattern = path.join(this.tempDir, 'chunk_%05d.wav');
    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', this.streamUrl,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'segment',
      '-segment_time', '3',
      '-segment_format', 'wav',
      segmentPattern
    ];

    this.ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    this.ffmpegProc.on('error', (err) => {
      console.error(`[Transcriber] FFmpeg error for ${this.streamId}:`, err.message);
    });

    this.ffmpegProc.on('exit', (code) => {
      console.log(`[Transcriber] FFmpeg exited with code ${code} for ${this.streamId}`);
    });

    this.pollInterval = setInterval(() => this.processNextChunks(), 1500);
  }

  async processNextChunks() {
    if (!this.isAlive) return;

    try {
      const files = fs.readdirSync(this.tempDir)
        .filter(f => f.startsWith('chunk_') && f.endsWith('.wav'))
        .sort();

      if (files.length <= 1) return;

      for (let i = 0; i < files.length - 1; i++) {
        const file = files[i];
        const filePath = path.join(this.tempDir, file);

        try {
          const stats = fs.statSync(filePath);
          if (stats.size > 1000) {
            const rawEnglishText = await this.transcribeAudioChunk(filePath);
            if (rawEnglishText && rawEnglishText.trim().length > 0) {
              const cleanedText = rawEnglishText.trim();
              const cueStartTime = (Date.now() - this.startTime) / 1000;
              const cueEndTime = cueStartTime + 3.5;

              // Generate translations
              const translations = {
                eng: cleanedText,
                fre: await this.translateText(cleanedText, 'French'),
                spa: await this.translateText(cleanedText, 'Spanish'),
                ger: await this.translateText(cleanedText, 'German'),
                ita: await this.translateText(cleanedText, 'Italian')
              };

              const newCue = {
                start: cueStartTime,
                end: cueEndTime,
                text: translations
              };

              this.cues.push(newCue);
              if (this.cues.length > 60) this.cues.shift();

              console.log(`[Transcriber] [${this.streamId}] Live: "${cleanedText}"`);

              // Broadcast new cue to all active streaming HTTP responses
              this.broadcastCue(newCue);
            }
          }
        } catch (e) {
          console.error(`[Transcriber] Error processing chunk ${file}:`, e.message);
        } finally {
          try { fs.unlinkSync(filePath); } catch (_) {}
        }
      }
    } catch (err) {
      console.error(`[Transcriber] Poll error:`, err.message);
    }
  }

  async transcribeAudioChunk(audioPath) {
    if (!this.apiKey) return "";

    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(audioPath));
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('response_format', 'json');
      formData.append('temperature', '0.0');

      const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 8000
      });

      return response.data.text || "";
    } catch (err) {
      return "";
    }
  }

  async translateText(text, targetLanguage) {
    if (!this.apiKey || !text || targetLanguage === 'English') return text;

    try {
      const prompt = `Translate the following live sports commentary sentence accurately into ${targetLanguage}. Output ONLY the direct translation and nothing else:\n\n"${text}"`;
      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 100
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 3000
      });

      return response.data.choices[0]?.message?.content?.replace(/^["']|["']$/g, '').trim() || text;
    } catch (err) {
      return text; // Fallback to original text if translation fails
    }
  }

  attachListener(res, lang = 'eng') {
    this.touch();
    
    // Set headers for live streaming WebVTT
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Send WebVTT Header
    res.write("WEBVTT\n\n");

    // Send recent buffered cues
    for (const cue of this.cues) {
      const text = cue.text[lang] || cue.text['eng'] || '';
      res.write(`${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${text}\n\n`);
    }

    const listener = { res, lang };
    this.listeners.add(listener);

    // Heartbeat keep-alive every 5s
    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.closed) {
        clearInterval(keepAlive);
        this.listeners.delete(listener);
        return;
      }
      res.write(`NOTE heartbeat\n\n`);
    }, 5000);

    res.on('close', () => {
      clearInterval(keepAlive);
      this.listeners.delete(listener);
    });
  }

  broadcastCue(cue) {
    for (const listener of this.listeners) {
      try {
        if (!listener.res.writableEnded && !listener.res.closed) {
          const text = cue.text[listener.lang] || cue.text['eng'] || '';
          listener.res.write(`${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${text}\n\n`);
        }
      } catch (e) {
        this.listeners.delete(listener);
      }
    }
  }

  destroy() {
    this.isAlive = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGKILL'); } catch (_) {}
    }
    for (const listener of this.listeners) {
      try { listener.res.end(); } catch (_) {}
    }
    this.listeners.clear();
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch (_) {}
    console.log(`[Transcriber] Session ${this.streamId} destroyed.`);
  }
}

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
}

function pad(num, size = 2) {
  let s = num + "";
  while (s.length < size) s = "0" + s;
  return s;
}

function getOrCreateSession(streamUrl, streamId, apiKey) {
  if (sessions.has(streamId)) {
    const session = sessions.get(streamId);
    session.touch();
    return session;
  }

  const session = new StreamSession(streamUrl, streamId, apiKey);
  sessions.set(streamId, session);
  return session;
}

// Cleanup inactive sessions (no active listeners or requests for > 60s)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.listeners.size === 0 && (now - session.lastAccessTime > 60000)) {
      console.log(`[Transcriber] Cleaning up idle session: ${id}`);
      session.destroy();
      sessions.delete(id);
    }
  }
}, 15000);

module.exports = {
  getOrCreateSession
};
