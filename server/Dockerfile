FROM node:22-alpine

# Only the dependencies are baked into the image, at /app/node_modules. The
# code itself (server/ and shared/) is bind-mounted at runtime — see
# docker-compose.yml — so uploading new files doesn't need a rebuild. Node
# resolves /app/node_modules from /app/server by walking up the tree.
# Rebuild only when package.json/package-lock.json change.
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

WORKDIR /app/server

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

USER node

CMD ["/app/node_modules/.bin/pm2-runtime", "ecosystem.config.js"]
