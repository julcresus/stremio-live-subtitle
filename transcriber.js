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
              // Keep last 30 cues
              if (this.cues.length > 30) this.cues.shift();

              console.log(`[Transcriber] [${this.streamId}] (Orig): "${originalText}" -> (EN): "${english}"`);
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

  getWebVTT(lang = 'eng') {
    this.touch();
    let vtt = "WEBVTT\n\n";

    if (this.cues.length === 0) {
      vtt += `00:00:00.000 --> 00:00:05.000\n[🎙️ Live AI Subtitles Active]\n\n`;
      return vtt;
    }

    // Sequence the accumulated cues starting at 00:00:00.000
    // Each cue is displayed for 3.5 seconds in order so MPV parses and displays them smoothly
    let currentSec = 0;
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      const startSec = currentSec;
      const endSec = startSec + 3.8;
      currentSec = endSec;

      const text = cue.text[lang] || cue.text['eng'] || cue.text['orig'] || '';
      vtt += `${formatTime(startSec)} --> ${formatTime(endSec)}\n${text}\n\n`;
    }

    return vtt;
  }

  destroy() {
    this.isAlive = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGKILL'); } catch (_) {}
    }
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

// Cleanup inactive sessions after 90s
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastAccessTime > 90000) {
      console.log(`[Transcriber] Cleaning up idle session: ${id}`);
      session.destroy();
      sessions.delete(id);
    }
  }
}, 15000);

module.exports = {
  getOrCreateSession
};
