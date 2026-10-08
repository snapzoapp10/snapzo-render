FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates fonts-dejavu-core \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs .
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.mjs"]
