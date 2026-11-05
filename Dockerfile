FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run check && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DUET_HOST=0.0.0.0 DUET_DATA_DIR=/data PORT=3647
USER node
EXPOSE 3647
CMD ["npm","start"]
