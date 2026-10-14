FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY ecosystem.config.js ./
COPY public/ ./public/

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

USER node

CMD ["node_modules/.bin/pm2-runtime", "ecosystem.config.js"]
