# 📺 Stremio Live Subtitles Proxy (Sports Streams)

Cloud-hosted Stremio Add-on proxy that injects **real-time AI commentary subtitles** into live sports streams from `sports.highfly.dev`, enabling live captions directly on **LG TV (webOS)**, Android TV, Samsung TV, and Desktop.

---

## ⚡ How It Works

1. **Proxies Sports Streams**: Wraps all matches, channels, and streams from `sports.highfly.dev`.
2. **Real-Time Speech-to-Text**: Injects a live subtitle track (`.vtt`) for each stream. When a stream is played on your TV, the server samples the live commentary audio using FFmpeg and transcribes it in real-time via ultra-fast Whisper AI (~200ms latency).
3. **Displays Subtitles on LG TV**: The LG TV native player receives the live WebVTT cues and shows real-time commentary subtitles on screen.

---

## 🚀 Quick Setup & 1-Click Free Deployment

### Step 1: Get a Free Groq API Key
1. Go to [https://console.groq.com](https://console.groq.com) and sign up (free).
2. Go to **API Keys** $\rightarrow$ **Create API Key**.
3. Copy your key (starts with `gsk_...`).

---

### Step 2: Deploy to Cloud (Free on Render)

#### Method A: Deploy via GitHub + Render (Recommended)
1. Push this folder to a new repository on your [GitHub](https://github.com).
2. Go to [Render Dashboard](https://dashboard.render.com/) $\rightarrow$ Click **New +** $\rightarrow$ **Web Service**.
3. Connect your GitHub repository.
4. Render will auto-detect the `Dockerfile` and `render.yaml`.
5. Under **Environment Variables**, add:
   * `GROQ_API_KEY`: Paste your `gsk_...` key from Step 1.
6. Click **Create Web Service**.

Once deployed, Render gives you a public URL (e.g. `https://stremio-live-subs.onrender.com`).

---

### Step 3: Install Add-on into Stremio (Syncs to LG TV)

1. Open your deployed URL in any web browser:
   ```
   https://your-app.onrender.com
   ```
2. Click the **"Install to Stremio"** button (or copy `https://your-app.onrender.com/manifest.json` and paste it into Stremio's Add-on search bar).
3. Confirm installation.
4. **Turn on your LG TV and open Stremio**:
   * Navigate to **Sports Streams (Live Subtitles)** in your library/catalog.
   * Play any match.
   * The **🎙️ Live AI Subtitles** track will appear and stream live captions directly on your TV screen!

---

## 💻 Optional: Running Locally on Mac

If you want to test or run it locally on your Mac:

```bash
# 1. Install dependencies
npm install

# 2. Set your Groq API key
export GROQ_API_KEY="gsk_..."

# 3. Start the server
npm start
```
* Open `http://localhost:7000` to view the install page.
