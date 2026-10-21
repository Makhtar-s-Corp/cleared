# Cleared v2 egress proxy image (milestone 1 plan, decision 4): proxy.ts run
# by Node's type stripping, with no dependency. Built by the service, labelled:
#   docker build --label cleared.dev=v2 --tag cleared-v2-egress:1 v2/images/egress
FROM node:24
WORKDIR /opt/cleared/egress
COPY proxy.ts ./proxy.ts
USER node
CMD ["node", "proxy.ts"]
