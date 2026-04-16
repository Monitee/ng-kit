FROM node:20-alpine

# Install build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY server.js .

RUN mkdir -p /data

EXPOSE 3100

ENV PORT=3100
ENV DATA_DIR=/data
ENV MAX_MEMORIES=10000
ENV INFERENCE_URL=https://nodeghost.ai/v1
ENV CORS_ORIGINS=*
ENV PUBLIC_NAMESPACES=knowledge-base
ENV NODE_OPTIONS=--max-old-space-size=4096

CMD ["node", "server.js"]
