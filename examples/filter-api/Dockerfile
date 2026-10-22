# The filter API as the deploy watcher runs it (deploy/watch.ts). Node runs
# the TypeScript itself (type stripping): no build step, and no dependency
# to install, so the image has no RUN step.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8795
COPY package.json words.txt ./
COPY src ./src
USER node
EXPOSE 8795
CMD ["node", "src/main.ts"]
