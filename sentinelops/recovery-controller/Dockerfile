FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY sentinelops/recovery-controller ./sentinelops/recovery-controller
RUN npm run build:recovery-controller

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/sentinelops/recovery-controller/dist ./sentinelops/recovery-controller/dist
EXPOSE 8090
CMD ["node", "sentinelops/recovery-controller/dist/src/server.js"]
