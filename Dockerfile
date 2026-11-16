FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY apps/test-service ./apps/test-service
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S sentinelops && adduser -S sentinelops -G sentinelops
COPY --from=build --chown=sentinelops:sentinelops /app/package*.json ./
COPY --from=build --chown=sentinelops:sentinelops /app/node_modules ./node_modules
COPY --from=build --chown=sentinelops:sentinelops /app/apps/test-service/dist ./apps/test-service/dist
USER sentinelops
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/test-service/dist/src/server.js"]
