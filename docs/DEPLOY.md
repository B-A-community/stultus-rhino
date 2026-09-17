# Развёртывание Stultus Rhino у клиента

Два шага: сервер (gateway) и плагин на рабочих машинах. Проверено на нашей
виртуалке (Ubuntu 24.04, Docker 29, выход в интернет через локальный прокси)
и Rhino 8.30 на Windows.

## 1. Сервер (одна виртуалка или ПК в сети бюро)

Нужно: Linux с Docker и Compose v2, доступ в интернет к api.anthropic.com и
chatgpt.com/openai.com (напрямую или через локальный прокси), открытый порт
8792 внутри сети бюро.

```bash
sudo mkdir -p /opt/stultus-rhino/{claude,codex,data} && sudo chown -R $USER /opt/stultus-rhino
git clone https://github.com/B-A-community/stultus-rhino.git /opt/stultus-rhino/app
cp /opt/stultus-rhino/app/server/deploy/.env.example /opt/stultus-rhino/.env && chmod 600 /opt/stultus-rhino/.env
```

Заполнить `/opt/stultus-rhino/.env`:

- `PLUGIN_TOKEN` — длинная случайная строка, её же вводят сотрудники в
  окне плагина: `head -c 24 /dev/urandom | base64 | tr -d '/+='`.
- Если интернет через прокси: `HTTPS_PROXY`, `HTTP_PROXY`,
  `NODE_USE_ENV_PROXY=1`, `NO_PROXY=localhost,127.0.0.1,192.168.0.0/16`, и
  для сборки образа `BUILD_HTTP_PROXY`/`BUILD_HTTPS_PROXY` (без
  `NODE_USE_ENV_PROXY` процессы моделей молча висят).

Вход к моделям (контейнер работает от root, дом — тома):

- **Claude**: положить `.credentials.json` (Linux: `~/.claude/.credentials.json`
  с машины, где выполнен `claude login`) в `/opt/stultus-rhino/claude/`,
  права 600; либо `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), либо
  `ANTHROPIC_API_KEY`.
- **Codex**: положить `auth.json` (после `codex login`) в
  `/opt/stultus-rhino/codex/`; либо `CODEX_API_KEY`, но тогда постпродакшн
  не работает. Тот же вход использует генерация картинок:
  `RENDER_ENABLED=1`.
- Одна учётная запись в двух местах (например, gateway SketchUp на этой же
  машине) — нормально, пока обновление токена не происходит одновременно;
  при «refresh token revoked» повторить вход и скопировать файл заново.

Запуск:

```bash
cd /opt/stultus-rhino/app/server
docker compose -f deploy/docker-compose.yml --env-file /opt/stultus-rhino/.env up -d --build
curl http://localhost:8792/health
```

В ответе `providers` должны быть `configured: true` у нужных провайдеров,
`image_generation.configured: true`, если включён постпродакшн. Журнал:
`docker logs -f stultus-rhino`.

Обновление сервера (окно и инструменты у сотрудников обновятся сами при
следующем открытии окна):

```bash
cd /opt/stultus-rhino/app && git pull && cd server && docker compose -f deploy/docker-compose.yml --env-file /opt/stultus-rhino/.env up -d --build
```

Имя проекта Compose — `stultus-rhino`, порт 8792: на одной виртуалке
уживается со Stultus (SketchUp, 8790) и Stultus Cut (Premiere, 8791).

### Пакет хоста на сервере

Чтобы плагин обновлялся с сервера, положите свежий `.yak` в
`/opt/stultus-rhino/data/packages/`. Gateway отдаёт его по
`/download/<файл>.yak`, а в приветствии сообщает окну, что хост устарел
(`HOST_MIN_VERSION` в `server/src/version.ts`), — в окне появляется кнопка
«Обновить плагин».

### VPS в интернете

Как у Stultus: `HOST=127.0.0.1`, Caddy с Let's Encrypt (`sslip.io` без
своего домена), в плагине адрес `https://<имя>` — окно и WebSocket пойдут по
TLS с того же адреса.

## 2. Плагин на рабочих машинах

Требования: Rhino 8 (Windows, проверено на 8.30), WebView2 Runtime (ставится
вместе с Rhino 8), сеть до сервера.

1. Пакет: `build\stultus-rhino-<версия>-rh8_0-any.yak` — собрать
   `tools\build_yak.ps1` (нужен .NET 8 SDK: `winget install Microsoft.DotNet.SDK.8`)
   или взять готовый; с сервера — `http://<сервер>:8792/download/<файл>.yak`.
2. Rhino 8 → `_PackageManager` → Install from file, или в командной строке:
   `"C:\Program Files\Rhino 8\System\Yak.exe" install <файл>.yak`.
   Перезапустить Rhino.
3. Команда `Stultus` → окно подключения: адрес `http://<сервер>:8792` и
   пропуск из `PLUGIN_TOKEN` → «Сохранить и подключиться». В шапке должно
   стать «gateway <версия>» с зелёной точкой. Настройки хранятся на этой
   машине, в файлы моделей не попадают. Команда `StultusSettings`
   возвращает на страницу подключения.

Для разработки без пакета: `dotnet build -c Release` в `host\`,
`tools\dev_install.ps1` (регистрирует `.rhp` в реестре), перезапуск Rhino.
`tools\dev_install.ps1 -Remove` снимает регистрацию.

## 3. Первая проверка у клиента

В окне плагина, на тестовом документе:

1. «Построй куб 500 мм у начала координат, назови его «Тест»» → карточка
   execute_python, куб появился, Ctrl+Z его убирает.
2. Выделить куб → «покрась это в красный» → меняется только он.
3. «Сделай лестницу» → карточка с вопросами, ответить → построено.
4. «Попроси снимок вьюпорта в перспективе» → карточка «Разрешить» → модель
   описала вид.
5. Если `RENDER_ENABLED=1`: «сделай визуализацию этого вида».

## 4. Частые проблемы

- **Страница подключения с «Сервер недоступен»** — адрес, порт 8792,
  контейнер (`docker ps`, `/health`).
- **Красная точка, «пропуск не принят»** — `PLUGIN_TOKEN` в `.env` и в
  плагине различаются или контейнер не перезапущен после правки `.env`.
- **Провайдер «не настроен»** — нет входа: см. раздел про вход, после
  входа `docker compose … up -d`.
- **Ход идёт бесконечно без вызовов** — сервер не достаёт до API моделей:
  проверить прокси и `NODE_USE_ENV_PROXY=1`.
- **Codex: «refresh token was revoked»** — повторить `codex login`, скопировать `auth.json`.
- **Модель «не знает» новых инструментов** после обновления — начать новый
  разговор (корзина в шапке).
- **Первый вызов Python долгий** — RhinoCode поднимает CPython, это один раз
  за сессию Rhino.
- **Журнал хоста**: `%LOCALAPPDATA%\StultusRhino\host.log` — ошибки окна и
  моста, записи Undo, обновление.
