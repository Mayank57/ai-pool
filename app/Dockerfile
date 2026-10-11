FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
ENV APP_HOST=0.0.0.0 APP_PORT=8320 APP_DB=/data/aipool.db NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8320
USER node
CMD ["node", "server.mjs"]
