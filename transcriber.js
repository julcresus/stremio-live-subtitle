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
    this.cues = []; // { text: { [lang]: string }, createdAt: number }
    this.listeners = new Set(); // { res, lang, connectedAt: number }
    this.lastAccessTime = Date.now();
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
            const rawSpeech = await this.transcribeAudioChunk(filePath);
            if (rawSpeech && rawSpeech.trim().length > 0) {
              const originalText = rawSpeech.trim();

              // Translate concurrently into supported languages
              const [english, french, spanish, german, italian] = await Promise.all([
                this.translateText(originalText, 'English'),
                this.translateText(originalText, 'French'),
                this.translateText(originalText, 'Spanish'),
                this.translateText(originalText, 'German'),
                this.translateText(originalText, 'Italian')
              ]);

              const translations = {
                orig: originalText,
                eng: english,
                fre: french,
                spa: spanish,
                ger: german,
                ita: italian
              };

              const newCue = {
                text: translations,
                createdAt: Date.now()
              };

              this.cues.push(newCue);
              if (this.cues.length > 50) this.cues.shift();

              console.log(`[Transcriber] [${this.streamId}] (Orig): "${originalText}" -> (EN): "${english}"`);

              // Broadcast new cue to all connected Stremio players with synchronized timestamps
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
    if (!this.apiKey || !text) return text;

    try {
      const prompt = `Translate the following sports commentary line into ${targetLanguage}. If it is already in ${targetLanguage}, just keep it as is. Output ONLY the translation without any quotes, notes, or explanations:\n\n"${text}"`;
      const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 120
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 3500
      });

      return response.data.choices[0]?.message?.content?.replace(/^["']|["']$/g, '').trim() || text;
    } catch (err) {
      return text;
    }
  }

  attachListener(res, lang = 'eng') {
    this.touch();
    const connectedAt = Date.now();

    // Set headers for live streaming WebVTT
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Send WebVTT Header
    res.write("WEBVTT\n\n");

    // If we have recent cues, send the latest one at timestamp 00:00:00
    if (this.cues.length > 0) {
      const latest = this.cues[this.cues.length - 1];
      const text = latest.text[lang] || latest.text['eng'] || latest.text['orig'] || '';
      res.write(`00:00:00.000 --> 00:00:04.000\n${text}\n\n`);
    } else {
      res.write(`00:00:00.000 --> 00:00:04.000\n[🎙️ Live AI Subtitles Connecting...]\n\n`);
    }

    const listener = { res, lang, connectedAt };
    this.listeners.add(listener);

    // Heartbeat keep-alive every 4s
    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.closed) {
        clearInterval(keepAlive);
        this.listeners.delete(listener);
        return;
      }
      res.write(`NOTE heartbeat\n\n`);
    }, 4000);

    res.on('close', () => {
      clearInterval(keepAlive);
      this.listeners.delete(listener);
    });
  }

  broadcastCue(cue) {
    const now = Date.now();
    for (const listener of this.listeners) {
      try {
        if (!listener.res.writableEnded && !listener.res.closed) {
          const elapsed = (now - listener.connectedAt) / 1000;
          const startSec = Math.max(0, elapsed);
          const endSec = startSec + 4.5;

          const text = cue.text[listener.lang] || cue.text['eng'] || cue.text['orig'] || '';
          listener.res.write(`${formatTime(startSec)} --> ${formatTime(endSec)}\n${text}\n\n`);
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

// Cleanup inactive sessions
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
