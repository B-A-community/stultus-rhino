# Gateway Stultus Rhino. Сборка из каталога server:
#   docker compose -f deploy/docker-compose.yml up -d --build
# Выход в интернет на виртуалке идёт через локальный прокси (127.0.0.1:8888),
# поэтому сборка идёт с network: host и переменными прокси из compose.
FROM node:24-bookworm-slim

ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY

WORKDIR /app
ENV NODE_ENV=production

# Зависимости отдельно — слой кэшируется, пока package*.json не меняются.
# Скрипты установки не отключаем: sharp и codex тянут нативные части.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
RUN npx --yes typescript@5 tsc -p tsconfig.json

# Окно и Python-скрипты инструментов раздаются с сервера (/ui/).
COPY ui ./ui
COPY rhino ./rhino

# Прокси нужен только процессам на этапе работы через .env — переменные сборки убираем.
ENV HTTP_PROXY= HTTPS_PROXY=

# Сессии Claude Code, вход Codex и данные (копилка, пакеты) живут в томах.
VOLUME ["/root/.claude", "/root/.codex", "/app/data"]

EXPOSE 8792
CMD ["node", "dist/index.js"]
