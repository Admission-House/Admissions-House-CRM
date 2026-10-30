# syntax=docker/dockerfile:1
# Builds the API into a small image that runs as an unprivileged user.

FROM node:24-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
RUN pnpm --filter @ah/api build \
 && pnpm --filter @ah/api deploy --prod --legacy /out

FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
RUN mkdir -p /app/.secrets && chown node:node /app/.secrets
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
