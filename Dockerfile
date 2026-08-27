FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

# The build compiles src only — tsconfig.json includes nothing else. Tests are
# excluded from the build context by .dockerignore and are not needed here;
# CI runs them before anything reaches a registry.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Created here, before the volume is mounted, so a named volume inherits this
# ownership on first use. The process runs as `node`, and a volume Docker
# creates is owned by root: without this, the embedded authorization server
# cannot write its key and refuses to start.
RUN mkdir -p /data/firefly-mcp-auth && chown -R node:node /data

USER node
EXPOSE 3000

# Fails fast if MCP_HTTP_TOKEN is missing rather than listening unauthenticated.
CMD ["node", "dist/http.js"]
