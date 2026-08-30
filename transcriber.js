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
    this.cues = []; // { segId: number, text: { [lang]: string }, createdAt: number }
    this.segCounter = 0;
    this.sseListeners = new Set();
    this.overlayProcs = {};
    this.lastAccessTime = Date.now();
    this.isAlive = true;
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `sub_${streamId}_`));
    this.ffmpegProc = null;

    this.subtitleFiles = {
      eng: path.join(this.tempDir, 'sub_eng.txt'),
      fre: path.join(this.tempDir, 'sub_fre.txt'),
      orig: path.join(this.tempDir, 'sub_orig.txt')
    };

    fs.writeFileSync(this.subtitleFiles.eng, ' ', 'utf-8');
    fs.writeFileSync(this.subtitleFiles.fre, ' ', 'utf-8');
    fs.writeFileSync(this.subtitleFiles.orig, ' ', 'utf-8');

    this.startAudioCapture();
  }

  attachSseListener(res) {
    this.touch();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send history
    res.write(`data: ${JSON.stringify({ type: 'history', cues: this.cues })}\n\n`);

    const listener = (cue) => {
      res.write(`data: ${JSON.stringify({ type: 'cue', cue })}\n\n`);
    };

    this.sseListeners.add(listener);

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 5000);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseListeners.delete(listener);
    });
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
    if (!this.isAlive || this.isProcessing) return;
    this.isProcessing = true;

    try {
      if (!fs.existsSync(this.tempDir)) return;

      const files = fs.readdirSync(this.tempDir)
        .filter(f => f.startsWith('chunk_') && f.endsWith('.wav'))
        .sort();

      if (files.length <= 1) return;

      for (let i = 0; i < files.length - 1; i++) {
        const file = files[i];
        const filePath = path.join(this.tempDir, file);

        if (!fs.existsSync(filePath)) continue;

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

              this.segCounter++;
              const newCue = {
                segId: this.segCounter,
                text: {
                  orig: originalText,
                  eng: english,
                  fre: french,
                  spa: spanish,
                  ger: german,
                  ita: italian
                },
                createdAt: Date.now()
              };

              this.cues.push(newCue);
              // Keep last 40 cues in memory
              if (this.cues.length > 40) this.cues.shift();

              // Write current subtitle line to disk for in-video overlay
              try {
                fs.writeFileSync(this.subtitleFiles.eng, english || ' ', 'utf-8');
                fs.writeFileSync(this.subtitleFiles.fre, french || ' ', 'utf-8');
                fs.writeFileSync(this.subtitleFiles.orig, originalText || ' ', 'utf-8');

                // Clear after 4 seconds
                setTimeout(() => {
                  try {
                    fs.writeFileSync(this.subtitleFiles.eng, ' ', 'utf-8');
                    fs.writeFileSync(this.subtitleFiles.fre, ' ', 'utf-8');
                    fs.writeFileSync(this.subtitleFiles.orig, ' ', 'utf-8');
                  } catch (_) {}
                }, 4000);
              } catch (_) {}

              console.log(`[Transcriber] [${this.streamId}] (Seg ${this.segCounter}) "${originalText}" -> EN: "${english}"`);

              // Broadcast live to all connected SSE browser overlays
              if (this.sseListeners) {
                for (const listener of this.sseListeners) {
                  try { listener(newCue); } catch (_) {}
                }
              }
            }
          }
        } catch (e) {
          // Ignore individual chunk read glitches
        } finally {
          try { 
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath); 
          } catch (_) {}
        }
      }
    } catch (err) {
      // Ignore directory read glitches
    } finally {
      this.isProcessing = false;
    }
  }

  // Start FFmpeg In-Video Subtitle Overlay Stream
  startVideoOverlayStream(lang = 'eng') {
    this.touch();
    const hlsDir = path.join(this.tempDir, `video_${lang}`);
    if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });

    if (this.overlayProcs && this.overlayProcs[lang]) {
      return hlsDir;
    }

    const subFile = this.subtitleFiles[lang] || this.subtitleFiles.eng;
    const escapedSubFile = subFile.replace(/\\/g, '/').replace(/:/g, '\\:');
    const m3u8Output = path.join(hlsDir, 'live.m3u8');
    
    // Draw text with font styling and black background box at the bottom of the video frame
    const fontOption = fs.existsSync('/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf')
      ? "fontfile='/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf':"
      : "";

    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', this.streamUrl,
      '-vf', `drawtext=${fontOption}textfile='${escapedSubFile}':reload=1:fontcolor=white:fontsize=26:box=1:boxcolor=black@0.65:boxborderw=6:x=(w-text_w)/2:y=h-text_h-35`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-c:a', 'copy',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '4',
      '-hls_flags', 'delete_segments',
      m3u8Output
    ];

    console.log(`[Transcriber] Launching In-Video Subtitle Transcoder for ${this.streamId} (${lang})`);
    const proc = spawn('ffmpeg', args);
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('fatal')) {
        console.error(`[FFmpeg Transcoder ${this.streamId}]`, msg.trim());
      }
    });

    proc.on('exit', (code) => {
      console.log(`[Transcriber] FFmpeg overlay transcoder exited with code ${code} for ${this.streamId}`);
      delete this.overlayProcs[lang];
    });

    this.overlayProcs[lang] = proc;
    return hlsDir;
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

  // Generate continuous HLS subtitle playlist (.m3u8)
  getHlsSubtitlePlaylist(host, encodedUrl, lang = 'eng') {
    this.touch();
    
    // Take the last 5 segments for the rolling live playlist
    const recent = this.cues.slice(-5);
    const mediaSeq = recent.length > 0 ? recent[0].segId : 1;

    let m3u8 = `#EXTM3U\n`;
    m3u8 += `#EXT-X-VERSION:3\n`;
    m3u8 += `#EXT-X-TARGETDURATION:4\n`;
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}\n\n`;

    if (recent.length === 0) {
      m3u8 += `#EXTINF:4.0,\n`;
      m3u8 += `${host}/hls/${encodedUrl}/seg_init_${lang}.vtt\n`;
      return m3u8;
    }

    for (const cue of recent) {
      m3u8 += `#EXTINF:3.5,\n`;
      m3u8 += `${host}/hls/${encodedUrl}/seg_${cue.segId}_${lang}.vtt\n`;
    }

    return m3u8;
  }

  // Generate single segment WebVTT chunk
  getSegmentVTT(segId, lang = 'eng') {
    this.touch();
    if (segId === 'init') {
      return `WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n[🎙️ Live AI Subtitles Active]\n\n`;
    }

    const id = parseInt(segId, 10);
    const cue = this.cues.find(c => c.segId === id);
    if (!cue) {
      return `WEBVTT\n\n00:00:00.000 --> 00:00:03.500\n...\n\n`;
    }

    const text = cue.text[lang] || cue.text['eng'] || cue.text['orig'] || '';
    return `WEBVTT\n\n00:00:00.000 --> 00:00:03.500\n${text}\n\n`;
  }

  // Fallback single WebVTT file
  getWebVTT(lang = 'eng') {
    this.touch();
    let vtt = "WEBVTT\n\n";

    if (this.cues.length === 0) {
      vtt += `00:00:00.000 --> 00:00:05.000\n[🎙️ Live AI Subtitles Active]\n\n`;
      return vtt;
    }

    let currentSec = 0;
    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i];
      const startSec = currentSec;
      const endSec = startSec + 3.5;
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
    if (this.overlayProcs) {
      for (const p of Object.values(this.overlayProcs)) {
        try { p.kill('SIGKILL'); } catch (_) {}
      }
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

  // Terminate any previous sessions so only 1 stream runs at a time
  for (const [id, oldSession] of sessions.entries()) {
    console.log(`[Transcriber] Terminating previous session ${id} for new stream ${streamId}`);
    oldSession.destroy();
    sessions.delete(id);
  }

  const session = new StreamSession(streamUrl, streamId, apiKey);
  sessions.set(streamId, session);
  return session;
}

// Cleanup inactive sessions after 45s
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastAccessTime > 45000) {
      console.log(`[Transcriber] Cleaning up idle session: ${id}`);
      session.destroy();
      sessions.delete(id);
    }
  }
}, 10000);

module.exports = {
  getOrCreateSession
};
