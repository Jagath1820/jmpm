# Stage 1: Build & Typecheck
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root manifest and project files
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/ apps/
COPY packages/ packages/
COPY services/ services/
COPY prisma/ prisma/

# Install dependencies
RUN npm ci

# Ahead-Of-Time compile all TypeScript packages to pure JavaScript
RUN npm run build

# Stage 2: Production Runner (Hardened, Zero-Transpiler Overhead)
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4873
ENV HOST=0.0.0.0

# Copy compiled app and dependencies from builder
COPY --from=builder /app /app

# Persistent storage directory
RUN mkdir -p /app/storage/tarballs
VOLUME ["/app/storage"]

EXPOSE 4873

# Pure native Node.js execution (matches oauth production standard)
CMD ["node", "apps/registry-api/dist/start.js"]
