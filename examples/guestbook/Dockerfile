# The guestbook as the deploy watcher runs it (deploy/watch.ts). Node runs
# the TypeScript itself (type stripping): no build step, no dev dependency.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8793
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 8793
CMD ["node", "src/main.ts"]
