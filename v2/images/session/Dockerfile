# Cleared v2 session image (milestone 1 plan, lane 2): Node 24, git, Claude
# Code and the Agent SDK at pinned versions. Built by the service, labelled
# cleared.dev=v2:
#   docker build --label cleared.dev=v2 --tag cleared-v2-session:2.1.306 v2/images/session
# The container runs read only, as the service's uid, with /tmp, the workdir
# and the config volume writable (src/container/session-runtime.ts).
FROM node:24

# Claude Code reads both: no update check, no telemetry or error reporting.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/var/lib/cleared/claude-config \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# The package's postinstall puts the native binary in place; npm runs it only
# when allowed by name.
RUN npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.306 \
 && claude --version \
 && npm cache clean --force

# The runner and its dependencies: main.ts (lane 4) next to hooks.ts (lane 5)
# and schema.ts (milestone 2, lane 4). The service starts it as
# node /opt/cleared/runner/main.ts. zod is the SDK's peer dependency, which
# npm installed unpinned until milestone 2; the runner now builds the host
# tools' schemas with it (schema.ts), so it is pinned to the version npm
# resolved on 2026-10-22.
WORKDIR /opt/cleared/runner
RUN npm init --yes > /dev/null \
 && npm pkg set type=module \
 && npm install --save-exact --no-audit --no-fund @anthropic-ai/claude-agent-sdk@0.3.306 zod@4.6.7 \
 && npm ls --all --depth=1 \
 && npm cache clean --force
COPY runner/hooks.ts ./hooks.ts
COPY runner/schema.ts ./schema.ts
COPY runner/main.ts ./main.ts

# The config volume is created from this folder: writable whatever uid the
# service runs the session as.
RUN install -d -m 1777 /var/lib/cleared/claude-config

WORKDIR /workspace
USER node
