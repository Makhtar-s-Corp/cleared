# Cleared v2 fake service image (milestone 2 plan, decision 20): fake.ts run
# by Node's type stripping, with no dependency. It answers a service's
# contract from its examples, in place of a sibling that cannot run for
# real. Built by the service, labelled:
#   docker build --label cleared.dev=v2 --tag cleared-v2-fake:1 v2/images/fake
# The contract is mounted read only at run time; nothing else is copied.
FROM node:24-slim
WORKDIR /opt/cleared/fake
COPY yaml.ts ./yaml.ts
COPY fake.ts ./fake.ts
USER node
CMD ["node", "fake.ts"]
