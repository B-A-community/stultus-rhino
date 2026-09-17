# Gateway Stultus Rhino. Сборка из каталога server:
#   docker compose -f deploy/docker-compose.yml --env-file /opt/stultus-rhino/.env up -d --build
# Выход в интернет на виртуалке идёт через локальный прокси (127.0.0.1:8888),
# поэтому сборка идёт с network: host и переменными прокси из compose.

# --- Сборка TypeScript: нужны dev-зависимости (typescript, @types) --------
FROM node:24-bookworm-slim AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Образ для работы: только рабочие зависимости --------------------------
FROM node:24-bookworm-slim
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY
WORKDIR /app
ENV NODE_ENV=production

# Скрипты установки не отключаем: sharp и codex тянут нативные части.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Окно и Python-скрипты инструментов раздаются с сервера (/ui/).
COPY ui ./ui
COPY rhino ./rhino

# Прокси нужен процессам только через .env — переменные сборки убираем.
ENV HTTP_PROXY= HTTPS_PROXY=

# Сессии Claude Code, вход Codex и данные (копилка, пакеты) живут в томах.
VOLUME ["/root/.claude", "/root/.codex", "/app/data"]

EXPOSE 8792
CMD ["node", "dist/index.js"]
