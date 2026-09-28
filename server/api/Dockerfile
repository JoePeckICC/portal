# Portal API on Cloud Run. Playwright's image carries Node 22 + a Chromium the PDF renderer uses.
FROM mcr.microsoft.com/playwright:v1.49.0-noble
ENV NODE_ENV=production PORT=8080 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
# ffmpeg makes appointment recordings (.m4a and the rest) into the one format the transcription service reads.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER pwuser
EXPOSE 8080
CMD ["node", "src/index.js"]
