FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/vph.sqlite

COPY --chown=node:node . /app
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
