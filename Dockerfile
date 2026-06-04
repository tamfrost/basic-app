FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || true

COPY server.js ./
COPY public/ ./public/

ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV PORT=3000 GIT_COMMIT=$GIT_COMMIT BUILD_TIME=$BUILD_TIME
EXPOSE 3000

CMD ["node", "server.js"]
