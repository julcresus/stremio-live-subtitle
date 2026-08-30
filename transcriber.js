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
    this.cues = []; // { start: number, end: number, text: string }
    this.lastAccessTime = Date.now();
    this.startTime = Date.now();
    this.isAlive = true;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `sub_${streamId}_`));
    this.segmentCounter = 0;
    this.ffmpegProc = null;

    this.startAudioCapture();
  }

  touch() {
    this.lastAccessTime = Date.now();
  }

  startAudioCapture() {
    console.log(`[Transcriber] Starting live audio extraction for ${this.streamId}`);
    
    // Use ffmpeg to extract live audio into 3-second wav slices
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

    this.ffmpegProc.stderr.on('data', (data) => {
      // Optional ffmpeg debug logs (disabled to reduce log noise)
    });

    this.ffmpegProc.on('error', (err) => {
      console.error(`[Transcriber] FFmpeg error for ${this.streamId}:`, err.message);
    });

    this.ffmpegProc.on('exit', (code) => {
      console.log(`[Transcriber] FFmpeg exited with code ${code} for ${this.streamId}`);
    });

    // Start polling directory for new completed wav chunks
    this.pollInterval = setInterval(() => this.processNextChunks(), 1500);
  }

  async processNextChunks() {
    if (!this.isAlive) return;

    try {
      const files = fs.readdirSync(this.tempDir)
        .filter(f => f.startsWith('chunk_') && f.endsWith('.wav'))
        .sort();

      // We process files up to (files.length - 1) to ensure the current chunk is completely written
      if (files.length <= 1) return;

      for (let i = 0; i < files.length - 1; i++) {
        const file = files[i];
        const filePath = path.join(this.tempDir, file);

        try {
          const stats = fs.statSync(filePath);
          if (stats.size > 1000) { // Valid non-empty audio
            const text = await this.transcribeAudioChunk(filePath);
            if (text && text.trim().length > 0) {
              const cueStartTime = (Date.now() - this.startTime) / 1000;
              const cueEndTime = cueStartTime + 3;
              this.cues.push({
                start: cueStartTime,
                end: cueEndTime,
                text: text.trim()
              });
              // Keep only the most recent 50 cues to prevent memory bloat
              if (this.cues.length > 50) {
                this.cues.shift();
              }
              console.log(`[Transcriber] [${this.streamId}] Subtitle: "${text.trim()}"`);
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
    if (!this.apiKey) {
      // Mock / fallback placeholder if no API key is set
      return "";
    }

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
      if (err.response) {
        console.error(`[Transcriber] Groq API error:`, err.response.status, err.response.data);
      } else {
        console.error(`[Transcriber] Groq request error:`, err.message);
      }
      return "";
    }
  }

  getWebVTT() {
    this.touch();
    let vtt = "WEBVTT\n\n";

    if (this.cues.length === 0) {
      vtt += `00:00:00.000 --> 00:00:05.000\n[Live subtitles initializing...]\n\n`;
      return vtt;
    }

    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      vtt += `${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.text}\n\n`;
    }

    return vtt;
  }

  destroy() {
    this.isAlive = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.ffmpegProc) {
      try { this.ffmpegProc.kill('SIGKILL'); } catch (_) {}
    }
    // Clean up temp directory
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

// Session Manager
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

// Cleanup inactive sessions (no requests for > 45s)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastAccessTime > 45000) {
      console.log(`[Transcriber] Cleaning up idle session: ${id}`);
      session.destroy();
      sessions.delete(id);
    }
  }
}, 15000);

module.exports = {
  getOrCreateSession
};
