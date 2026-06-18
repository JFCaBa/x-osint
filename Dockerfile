# ── Stage 1: build the Vue SPA ──
FROM node:22-slim AS www-build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/www/package.json packages/www/package.json
RUN npm install --workspace @x-osint/www || npm install
COPY packages/www packages/www
RUN npm run build --workspace @x-osint/www

# ── Stage 2: build the API ──
FROM node:22-slim AS api-build
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY packages/api/package.json packages/api/package.json
RUN npm install --workspace @x-osint/api || npm install
COPY packages/api packages/api
RUN npm run build --workspace @x-osint/api

# ── Stage 3: runtime ──
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY packages/api/package.json ./package.json
RUN apt-get update && apt-get install -y python3 make g++ && \
    npm install --omit=dev && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=api-build /app/packages/api/dist ./dist
COPY --from=www-build /app/packages/www/dist ./www
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
