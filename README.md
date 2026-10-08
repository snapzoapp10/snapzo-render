# Snapzo Render Server

Downloads a YouTube section, converts to 9:16 with caption, uploads to Snapzo.

## Run free on GitHub Codespaces

1. Open this repo → green **Code** button → **Codespaces** tab → **Create codespace on main** (free, no card).
2. Wait for setup to finish (ffmpeg + yt-dlp install automatically).
3. In the terminal run:

   ```
   SECRET=your-secret-here node server.mjs
   ```

4. Open the **Ports** panel, find port **8787**, right-click → **Port Visibility** → **Public**.
5. Copy the forwarded URL (looks like `https://xxxx-8787.app.github.dev`) and set it as `RENDER_SERVER_URL` in the Snapzo app, with the same secret as `RENDER_SERVER_SECRET`.

Note: a free Codespace sleeps after 30 min of inactivity and free accounts get ~60 core-hours/month. Start it again from github.com/codespaces when needed.
