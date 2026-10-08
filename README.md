# Snapzo render server

Turns a YouTube link + start/end into a clean, captioned 9:16 MP4 and uploads it to Snapzo.

## Run (GitHub Codespaces)
Open the codespace terminal and run once:
```bash
git pull; SECRET=<your secret word> bash start.sh
```
That installs ffmpeg, yt-dlp and a YouTube token helper, then keeps the server running.
Make port 8787 **Public**. After that the codespace starts the server by itself, and Snapzo can update it remotely.
