# syntax=docker/dockerfile:1
# Frontend Портала ИБ: SPA собирается в статику, nginx отдаёт её и проксирует /api на backend.
ARG NODE_IMAGE=node:24.11.0-alpine3.22
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.0-alpine3.21

# Dev-образ для docker-compose.dev.yml: vite с горячей перезагрузкой, исходники монтируются с хоста.
FROM ${NODE_IMAGE} AS dev
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
EXPOSE 5173
CMD ["npm", "run", "dev"]

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public public
COPY src src
RUN npm run build

FROM ${NGINX_IMAGE} AS runtime
# Образ nginx-unprivileged работает от пользователя nginx (uid 101) и слушает непривилегированный порт.
COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8443
