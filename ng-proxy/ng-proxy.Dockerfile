FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
EXPOSE 3200
CMD ["node", "server.js"]
