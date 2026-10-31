# Cleared v2's own image (docs/v2/milestone-5-plan.md, section 4): the
# service, the app, the broker and the install, each a role of
# entrypoint.ts. Built by the install from the root of the clone, labelled
# by v2/compose.yaml:
#   docker compose -f v2/compose.yaml build install
# The entrypoint starts as root and runs each role as the owner of the state
# folder; the install alone stays root, to give that folder to the owner of
# the clone.
FROM node:24
LABEL cleared.dev=v2

# git and gh for the forge; the Docker CLI for the service's sessions and,
# with Compose and buildx, for the install (buildx so that Compose builds
# with BuildKit, which leaves no unlabelled intermediate container); python3
# for the broker's peer check (SO_PEERCRED); util-linux for flock (the
# lock's rollback); iproute2 for ss (the install's port check). Debian's own docker.io is too old for the
# Engine's API (Docker 29 refuses a 20.10 client) and its gh too old for
# `gh pr checks --json`. So the Docker CLI and Compose come from Docker's apt
# repository, as on this server, its signing key checked against its
# fingerprint before apt trusts it, each version pinned; and gh from its
# release's .deb, checked against the SHA-256 the release publishes (its apt
# repository keeps the latest version only). No script is piped to a shell.
ARG DOCKER_VERSION=29.8.1
ARG COMPOSE_VERSION=5.5.1
ARG BUILDX_VERSION=0.37.1
ARG GH_VERSION=2.101.0
ARG GH_SHA256_AMD64=f876a3b87bf67c94f773d17becca4dc7340b056dab901473a9260ee2a73e237b
ARG GH_SHA256_ARM64=9aec87f9a011b1521556b06cb003776e7e214144c8efd2144924a28d90c23057
RUN install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | grep -q '^fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:' \
 && . /etc/os-release \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) sum="$GH_SHA256_AMD64" ;; arm64) sum="$GH_SHA256_ARM64" ;; *) echo "no gh checksum for $arch" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/gh.deb "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb" \
 && echo "$sum  /tmp/gh.deb" | sha256sum -c - \
 && apt-get update \
 && apt-get install --yes --no-install-recommends git python3 util-linux iproute2 /tmp/gh.deb \
      "docker-ce-cli=5:${DOCKER_VERSION}-1~debian.${VERSION_ID}~${VERSION_CODENAME}" \
      "docker-compose-plugin=${COMPOSE_VERSION}-1~debian.${VERSION_ID}~${VERSION_CODENAME}" \
      "docker-buildx-plugin=${BUILDX_VERSION}-1~debian.${VERSION_ID}~${VERSION_CODENAME}" \
 && rm -rf /var/lib/apt/lists/* /tmp/gh.deb \
 && docker --version && docker compose version && docker buildx version && gh --version

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# v2 and the kept v1 lock (serve/release-broker.ts, merge-pr.ts,
# release-request.ts, ask-validation.ts and lib/), as in the clone.
WORKDIR /opt/cleared
COPY . .
WORKDIR /opt/cleared/v2
RUN npm ci --no-audit --no-fund \
 && npm run build \
 && npm cache clean --force \
 && chmod 755 src/cli/cleared.ts \
 && ln -s /opt/cleared/v2/src/cli/cleared.ts /usr/local/bin/cleared

# The receipt's captures (P210, flow/proof-capture.ts, issue #504): Playwright's
# headless Chromium and its ffmpeg, the builds the lockfile's playwright-core
# names, so that this image's version moves only with that lockfile. They are
# downloaded by that version of Playwright, which checks nothing beyond its own
# build numbers. The shell rather than the full browser, its libraries with no
# recommended package and no X server. Outside any home folder, since each role
# runs as the owner of the state folder.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
      libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon0 libxrandr2 \
 && rm -rf /var/lib/apt/lists/* \
 && node_modules/.bin/playwright-core install chromium-headless-shell ffmpeg \
 && chmod -R a+rX /opt/playwright

WORKDIR /opt/cleared
ENTRYPOINT ["node", "/opt/cleared/v2/images/cleared/entrypoint.ts"]
