FROM node:20-bookworm-slim AS frontend
WORKDIR /fe
COPY my-drive-frontend/package.json my-drive-frontend/package-lock.json ./
RUN npm ci
COPY my-drive-frontend ./
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./
COPY --from=frontend /fe/build ./public
ENV NODE_ENV=production
ENV FRONTEND_BUILD_PATH=/app/public
ENV PORT=5000
EXPOSE 5000
CMD ["node", "server.js"]
