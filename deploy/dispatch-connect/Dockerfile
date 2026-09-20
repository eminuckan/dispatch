FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

WORKDIR /workspace

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY patches patches
COPY infra/connect/package.json infra/connect/package.json

RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @dispatch/connect...

COPY infra/connect/src infra/connect/src
COPY infra/connect/tsconfig.json infra/connect/tsconfig.json

RUN chown -R node:node /workspace
USER node

EXPOSE 8787

CMD ["pnpm", "--filter", "@dispatch/connect", "start"]
