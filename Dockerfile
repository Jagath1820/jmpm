# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root manifest and configs
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/ apps/
COPY packages/ packages/
COPY services/ services/
COPY prisma/ prisma/

# Install dependencies and build
RUN npm ci

# Production runner stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4873
ENV HOST=0.0.0.0

# Copy monorepo dependencies and code
COPY --from=builder /app /app

# Persistent storage directory
RUN mkdir -p /app/storage/tarballs
VOLUME ["/app/storage"]

EXPOSE 4873

CMD ["node", "--import", "tsx", "apps/registry-api/src/start.ts"]

