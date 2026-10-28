# syntax=docker/dockerfile:1
# Frontend Портала ИБ: SPA собирается в статику, nginx отдаёт её и проксирует /api на backend.
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.2-alpine3.23@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8

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
COPY --chown=101:101 nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
# При старте: правило перенаправления на PORTAL_URL (conf.d/00-portal-url.conf).
COPY --chmod=755 portal-url.sh /docker-entrypoint.d/40-portal-url.sh
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8443
