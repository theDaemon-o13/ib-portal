# syntax=docker/dockerfile:1
# Backend Портала ИБ. Сборка на машине с доступом к npm, на сервере образ только загружается.
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma/schema.prisma prisma/schema.prisma
# Без optional: единственная optional-зависимость production — @napi-rs/canvas (pdfjs-dist), она не нужна для
# извлечения текста и не должна попасть в образ (make-release.sh проверяет).
RUN npm ci --omit=optional

# Dev-образ для docker-compose.dev.yml: зависимости внутри образа, исходники монтируются с хоста.
FROM ${NODE_IMAGE} AS dev
WORKDIR /app
# Как в runtime: пустой том ibportal_dev_files при первом подключении наследует владельца node.
RUN chown node:node /app && mkdir -p /data/files && chown node:node /data/files
USER node
COPY --chown=node:node package.json package-lock.json prisma.config.ts ./
COPY --chown=node:node prisma/schema.prisma prisma/schema.prisma
# В dev optional нужны (esbuild, rollup для tsx и vitest) — кроме @napi-rs/canvas от pdfjs-dist.
RUN npm ci && rm -rf node_modules/@napi-rs
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY prisma prisma
COPY src src
COPY scripts scripts
RUN npm run build && npm prune --omit=dev --omit=optional
# Размер образа (−~115 МБ): среды выполнения клиента Prisma для других СУБД (клиент сгенерирован под PostgreSQL),
# source map и типы TypeScript в runtime не загружаются. Prisma CLI (нужен migrate) загружает свои зависимости
# при старте — его не трогаем. Сборка падает, если Prisma переименует файлы среды PostgreSQL (ADR-0014).
RUN ls node_modules/@prisma/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs >/dev/null \
 && find node_modules/@prisma/client/runtime -name 'query_compiler_*' ! -name '*.postgresql.*' -delete \
 && find node_modules -name '*.map' -type f -delete \
 && rm -rf node_modules/@types

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# Закрытый контур: ни Prisma CLI (checkpoint — проверка версии и телеметрия), ни npm/npx (проверка обновлений,
# загрузка пакетов) не обращаются в интернет. migrate запускает npx prisma — пакет уже в образе.
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_OFFLINE=true \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /app
# prisma CLI и движки нужны сервису migrate; в закрытом контуре npx ничего не скачает.
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/dist dist
# Только схема и миграции: seed запускается из dist, его исходники в образ не попадают.
COPY --from=build --chown=node:node /app/prisma/schema.prisma prisma/schema.prisma
COPY --from=build --chown=node:node /app/prisma/migrations prisma/migrations
COPY --from=build --chown=node:node /app/package.json package.json
# Prisma 7: адрес БД для migrate берётся из prisma.config.ts (DATABASE_URL из compose).
COPY --from=build --chown=node:node /app/prisma.config.ts prisma.config.ts
# Пустой том ibportal_files при первом подключении наследует владельца node.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD ["node", "dist/scripts/healthcheck.js"]
CMD ["node", "dist/src/server.js"]
