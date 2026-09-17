# Stultus Rhino — мини-гайд для агента (Codex / Claude Code)

Ты работаешь с репозиторием `B-A-community/stultus-rhino`. Это плагин
Rhino 8, через который нейросеть правит открытый документ. Здесь — как всё
устроено, чем пользоваться и как проверить.

## 1. Схема

```
Rhino 8 + хост (C#)  ──WebView2──  окно чата (JS с gateway: /ui/, tools.js)
                                        │ WebSocket: ws://<gateway>:8792/ws
                                        ▼
                       gateway (Node 24, server/) — один на бюро
                                        │ MCP Streamable HTTP, localhost
                                        ▼
               процесс модели: Claude Code (Agent SDK) или Codex (codex-sdk)
```

- Каждое окно Rhino = одно WebSocket-соединение = свой MCP-сервер `stultus`.
- Хост в Rhino тонкий: окно и Python-скрипты инструментов приходят с gateway.
  Меняешь `server/ui/*` или `server/rhino/*.py` — сотрудникам ничего
  переустанавливать не надо. Меняешь `host/src/*` — нужен новый `.yak`.
- Системная подсказка одна на всех: `server/src/prompt.ts` (Codex читает
  её из `AGENTS.md` рабочего каталога).

## 2. Инструменты MCP-сервера `stultus`

Определены в `server/src/mcp.ts`. Все длины — единицы документа (`units` в
снимке сцены), идентификаторы — GUID.

| Инструмент | Аргументы | Что возвращает | Кто исполняет |
|---|---|---|---|
| `execute_python` | `code`, `label?` | `result:` переменная `result` (JSON), `stdout:`; при ошибке трассировка, «объекты … удалены» | хост, RhinoCode, в записи Undo хода |
| `get_scene` | — | JSON снимка (см. PROTOCOL) | скрипт `rhino/scene_state.py` |
| `select` | `ids[]`, `mode?`, `zoom?` | `selected`, `text`, `missing_ids?` | `rhino/select.py` |
| `take_screenshot` | `reason`, `view?`, `zoom_extents?`, `display_mode?` | текст + `image` | пользователь → `rhino/screenshot.py` |
| `named_views` | `action`, `name?` | список/камера | `rhino/named_views.py` |
| `render_viewport` | `prompt`, `size?`, `save_path?` | картинка постпродакшна | пользователь → gateway (`render.ts`, `tiles.ts`) |
| `save_recipe` / `get_recipe` | … | копилка | gateway (`recipes.ts`) |
| `undo` | — | `ok` | хост: закрыть запись, `_-Undo` |
| `ask_user` | `questions[]` | «вопросы показаны…» | окно |

## 3. Как проверить на живом Rhino без кликов

Хост умеет мост разработки: запусти Rhino с `STULTUS_RHINO_DEV=1` (или
`dev_bridge=true` в настройках плагина) — на `127.0.0.1:8799` появится HTTP:

```
python tests/dev.py health
python tests/dev.py python "import rhinoscriptsyntax as rs; result = rs.AllObjects()"
python tests/dev.py tool scene_state '{"full": true}'      # скрипт из gateway (127.0.0.1:8792)
python tests/dev.py message save_settings '{"settings":{"gateway":"http://127.0.0.1:8792","token":"devtoken"}}'
python tests/dev.py open                                    # открыть окно
python tests/dev.py chat "Построй куб 500 мм у начала координат"   # ход через окно, печатает ленту
python tests/dev.py snap                                    # лента окна как JSON
python tests/dev.py js "return document.title"              # JS в окне (нужен return)
```

Локальный gateway для разработки:
`cd server && PORT=8792 PLUGIN_TOKEN=devtoken node --experimental-strip-types src/index.ts`
(Codex берёт `~/.codex/auth.json`; для Claude на Windows укажи
`CLAUDE_CODE_PATH` на установленный `claude.exe` и `CLAUDE_ASSUME_LOGGED_IN=1`,
но вход SDK-бинарника отдельный — проще проверять Claude на виртуалке).

Второй экземпляр Rhino для тестов не мешает рабочему:
`Start-Process 'C:\Program Files\Rhino 8\System\Rhino.exe' /nosplash` с
переменной окружения. Хост загружается из `host\bin\Release\StultusRhino.rhp`
по регистрации `tools\dev_install.ps1`; после пересборки — перезапуск
этого экземпляра.

Журнал хоста: `%LOCALAPPDATA%\StultusRhino\host.log`. Журнал gateway:
`docker logs -f stultus-rhino` (на виртуалке) — видно каждый вызов
инструмента с временем.

## 4. Где что править

| Хочу | Файл |
|---|---|
| Новый инструмент модели | `server/src/mcp.ts` (схема) → `server/ui/app.js` `onToolCall` (маршрут) → скрипт в `server/rhino/*.py` (или обработчик в `host/src/Bridge.cs`, если нужен C#) |
| Изменить поведение модели | `server/src/prompt.ts` |
| Что уходит в промпт с сообщением | `server/src/chat.ts` `buildPrompt`, `server/rhino/scene_state.py` |
| Новый провайдер | файл в `server/src/providers/`, регистрация в `server/src/chat.ts` |
| Настройки сервера | `server/src/config.ts`, `server/deploy/.env.example` |
| Окно | `server/ui/` (дизайн Graphite — не менять без нужды) |
| Хост | `host/src/` → `dotnet build` → `tools/build_yak.ps1` → пакет в `data/packages` на gateway и поднять `HOST_MIN_VERSION` |

## 5. Договор Python-скриптов

`_common.py` приклеивается в начало каждого скрипта: даёт `A` (аргументы),
`DOC`, `describe`, `selection_summary`, `camera`, `png_base64`,
`app_data_dir`, `doc_content_dir`. Скрипт кладёт ответ в `result` (dict).
Исключение — ответ с `ok: false` и трассировкой. Никаких диалогов и ожидания
ввода: код идёт на главном потоке Rhino.

Известные грабли RhinoCommon из CPython: `System.Drawing` доступен после
`clr.AddReference("System.Drawing.Common")`; `vp.SetProjection` переименовывает
вьюпорт (возвращаем имя); `NamedViewTable.Restore` переименовывает вьюпорт
в имя вида (штатно); `rs.AddPipe` хочет нормализованные параметры;
`rg.Extrusion.Create` тянет по нормали плоскости профиля — знак зависит от
обхода.
