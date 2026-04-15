# ── Stage 1: development ─────────────────────────────────────────────────────
# Runs ts-node directly — no compilation step needed for local dev.
FROM node:22-alpine AS development

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# SQLite data directory (overridden by volume mount at runtime)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node_modules/.bin/ts-node", "src/index.ts"]


# ── Stage 2: builder ──────────────────────────────────────────────────────────
# Compiles TypeScript to dist/
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build


# ── Stage 3: production ───────────────────────────────────────────────────────
# Minimal image — only compiled JS + production deps.
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# SQLite data directory (overridden by volume mount at runtime)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/index.js"]
