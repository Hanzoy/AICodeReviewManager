# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ARG CLAUDE_CODE_VERSION=2.1.211
ENV NODE_ENV=production \
    HOME=/home/node
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git openssh-client tini \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
    && npm cache clean --force
COPY server ./server
COPY shared ./shared

RUN mkdir -p /app/data/manager /app/data/group-node \
    && chown -R node:node /app /home/node

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start:manager"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/web /usr/share/nginx/html

