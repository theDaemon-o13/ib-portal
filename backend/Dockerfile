# syntax=docker/dockerfile:1
# Backend Портала ИБ. Сборка на машине с доступом к npm, на сервере образ только загружается.
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma/schema.prisma prisma/schema.prisma
RUN npm ci

# Dev-образ для docker-compose.dev.yml: зависимости внутри образа, исходники монтируются с хоста.
FROM ${NODE_IMAGE} AS dev
WORKDIR /app
# Как в runtime: пустой том ibportal_dev_files при первом подключении наследует владельца node.
RUN chown node:node /app && mkdir -p /data/files && chown node:node /data/files
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma/schema.prisma prisma/schema.prisma
RUN npm ci
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY prisma prisma
COPY src src
COPY scripts scripts
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# prisma CLI и движки нужны сервису migrate; в закрытом контуре npx ничего не скачает.
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/dist dist
COPY --from=build --chown=node:node /app/prisma prisma
COPY --from=build --chown=node:node /app/package.json package.json
# Пустой том ibportal_files при первом подключении наследует владельца node.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD ["node", "dist/scripts/healthcheck.js"]
CMD ["node", "dist/src/server.js"]
