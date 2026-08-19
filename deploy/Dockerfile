FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci \
    && npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MULTICODE_RELAY_HOST=0.0.0.0 \
    MULTICODE_RELAY_PORT=7337
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages

USER node
EXPOSE 7337

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7337/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "packages/cli/dist/index.js", "relay", "serve"]
