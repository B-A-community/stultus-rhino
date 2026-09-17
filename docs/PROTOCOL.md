# Протокол Stultus Rhino

Три канала. Все — JSON.

```
Rhino (хост, C#) ◄─ chrome.webview.postMessage / Stultus.receive ─► окно (JS с gateway)
                                                                         │
                                                                 WebSocket, исходящий
                                                                         ▼
                                                                 gateway на виртуалке
                                                                         │
                                                         MCP (Streamable HTTP, localhost)
                                                                         ▼
                                                             Claude Code / Codex (процесс)
```

## 1. Окно ↔ хост

JS шлёт `window.chrome.webview.postMessage(JSON.stringify({ id, name, payload }))`,
хост отвечает `window.Stultus.receive({ id, result })`. Все ответы
асинхронные. В `result` всегда есть `ok` (хост добавляет `ok: true`, если
обработчик его не вернул); ошибка обработчика — `{ ok: false, error }`.

| Вызов | Аргументы | Ответ |
|---|---|---|
| `ready` | — | `{ settings, history, sessions, instance, archive, accent, python_ready }` |
| `python` | `{ tool, code, args, undo: none\|turn, turn?, turn_label?, label? }` | `{ ok, result, output, seconds }` или `{ ok: false, error, traceback, output }` — `result` = переменная `result` скрипта |
| `execute_python` | `{ code, label?, turn, turn_label }` | то же; при ошибке ещё `removed` — сколько созданных вызовом объектов удалено. Открывает запись Undo хода |
| `turn_end` | `{ turn }` | `{ ok }` — закрыть запись Undo хода |
| `undo` | `{ turn }` | `{ ok }` — закрыть запись, `_-Undo` |
| `save_history` | `{ messages[] }` | `{ saved }` — сколько сообщений влезло под лимит |
| `save_sessions` | `{ sessions: { claude?, codex? } }` | `{ ok }` |
| `clear_history` | — | `{ archived, archive }` |
| `restore_history` | — | `{ restored, messages[], sessions, archive }` |
| `save_accent` | `{ accent }` | `{ accent }` |
| `save_settings` | `{ settings }` | `{ settings }` — полный набор после записи |
| `check_gateway` | `{ gateway }` | `{ ok, gateway, version, host_min, ui }` — GET `/health` |
| `update_host` | `{ url, version }` | `{ ok, file, output, restart }` — скачать `.yak`, `yak install` |
| `log` | `{ text }` | `{ ok }` — в `%LOCALAPPDATA%\StultusRhino\host.log` |
| `open_url` | `{ url }` | `{ ok }` |

Хост → окно без запроса: `window.Stultus.selectionChanged()` при изменении
выделения (окно само запрашивает описание скриптом `scene_state` с
`full: false`), `window.Stultus.documentChanged()` при смене документа
(окно перезагружается).

`instance`: `{ app: 'rhino', app_version, plugin, pid, model_title,
model_path, model_file, model_guid, units }`.

### Скрипты инструментов (`/ui/tools.js`)

`window.StultusTools = { version, host_min, tools: { scene_state, select,
screenshot, named_views, attachments, render_assets } }` — исходники Python
с приклеенным `_common.py`. Договор: аргументы в `__stultus_args__` (dict),
ответ в переменной `result` (dict), `print` → `output`, исключение →
`ok: false` с трассировкой.

| Скрипт | Аргументы | Ответ |
|---|---|---|
| `scene_state` | `{ full }` | снимок сцены (ниже) |
| `select` | `{ ids[], mode?, zoom? }` | `{ selected, text, missing_ids?, hidden_or_locked_ids? }` |
| `screenshot` | `{ view?, zoom_extents?, display_mode?, width?, height?, framing? }` | `{ mime, base64, width, height, bytes, framing, camera }`; `framing: 'viewport'` — точный кадр вьюпорта, `width` — большой кадр |
| `named_views` | `{ action, name? }` | `{ views[] }` / `{ activated, camera }` / `{ added }` / … |
| `attachments` | `{ action: save\|read, name?, base64?, path? }` | `{ path, dir, bytes }` / `{ base64, bytes }` |
| `render_assets` | `{ action: store\|chunk\|read\|export_to\|export, id, … }` | как у Stultus для SketchUp |
| `grasshopper` | `{ action: status\|open\|new\|clear\|list\|find\|add\|slider\|set\|script\|wire\|unwire\|delete\|solve\|read\|save\|load\|zoom, … }` | по действию: объекты канваса (`id`, `nick`, входы/выходы, провода, данные), `problems` после решения, `items` с габаритами для `read` |

Снимок сцены:

```jsonc
{
  "title": "Дом.3dm", "path": "C:/…/Дом.3dm",
  "units": { "length": "mm", "tolerance": 0.001, "angle_tolerance_deg": 1 },
  "selection_summary": { "count": 2, "text": "1 экземпляр блока «Окно» из 20, 1 полисурфейс: Стена",
                         "by_type": { "InstanceReference": 1, "Brep": 1 },
                         "definitions": [ { "name": "Окно", "selected": 1, "total": 20 } ] },
  "selection": [ { "id": "guid", "type": "Brep", "name": "Стена", "layer": "Стены", "closed": true, "faces": 6,
                   "volume": 1.5e8, "area": 1.9e6, "bbox": { "min": [0,0,0], "max": [1000,500,300], "size": [1000,500,300] } } ],
  "counts": { "Brep": 12, "Curve": 40 }, "objects": [ … до 200, скрытые не показываются … ],
  "objects_total": 52, "truncated": false,
  "layers": ["Default", "Стены (скрыт)"], "current_layer": "Default",
  "materials": [], "blocks": [ { "name": "Окно", "instances": 20 } ], "groups": [], "named_views": ["Общий вид"],
  "camera": { "view": "Perspective", "eye": [...], "target": [...], "up": [...], "projection": "perspective",
              "lens_mm": 50, "display_mode": "Shaded", "size_px": [1200, 700] },
  "model_bbox": { "min": [...], "max": [...] }, "plugin": "0.1.0"
}
```

Типы объектов: `Brep`, `Surface`, `Extrusion`, `Curve`, `Mesh`, `SubD`,
`Point`, `PointCloud`, `InstanceReference`, `Light`, `Annotation`, `Hatch`,
`TextDot`. Все длины — в единицах документа.

Формат сообщения истории (то, что уходит в файл модели): как в Stultus:
`{ role, text, at, provider?, tools: [{ name, label, ok }], attachments?, render? }`.
Картинки в историю не пишутся.

## 2. Окно ↔ gateway (WebSocket `/ws`)

### Плагин → gateway

| type | Поля | Смысл |
|---|---|---|
| `hello` | `token`, `instance`, `sessions` | Первое сообщение. Плохой пропуск — закрытие с кодом 4401 |
| `chat` | `turn`, `text`, `provider`, `model`, `scene`, `sessions`, `attachments[]` | Ход пользователя |
| `tool_result` | `call_id`, `ok`, `content`, `image?`, `capture?`, `prompt?`, `size?` | Ответ на `tool_call` |
| `cancel` | — | Прервать текущий ход |
| `recipe_delete` | `id` | Удалить приём из копилки |

### Gateway → плагин

| type | Поля | Смысл |
|---|---|---|
| `welcome` | `version`, `providers[]`, `host_min`, `host_outdated`, `package` | После принятого `hello`; `package = { name, version }` — свежий `.yak` на сервере или `null` |
| `turn_start` | `turn` | Ход принят |
| `status` / `thinking` / `text` / `text_replace` | … | Поток ответа |
| `tool_call` | `call_id`, `name`, `args` | Выполнить инструмент и ответить `tool_result` |
| `ask` | `question`, `options[]` | Вопрос пользователю (ограничитель расхода) |
| `session` | `provider`, `id` | Идентификатор сессии — окно сохраняет в документ |
| `done` | `usage?` | Ход окончен |
| `error` | `message` | Ход оборван с ошибкой |
| `recipes` | `recipes[]` | Копилка приёмов |
| `render_status` / `render_result` / `render_chunk` | … | Постпродакшн |

### Инструменты (`tool_call.name`)

| name | args | Кто отвечает |
|---|---|---|
| `execute_python` | `{ code, label? }` | хост, в записи Undo хода |
| `get_scene` | `{}` | скрипт `scene_state` |
| `select` | `{ ids?, mode?, zoom? }` | скрипт `select` |
| `take_screenshot` | `{ reason, view?, zoom_extents?, display_mode? }` | **пользователь**: карточка → скрипт `screenshot` |
| `named_views` | `{ action, name? }` | скрипт `named_views` |
| `grasshopper` | `{ action, … }` | скрипт `grasshopper` |
| `render_viewport` | `{ prompt, render_id, size, sizes, save_path }` | **пользователь**: карточка → `screenshot` с `framing: 'viewport'`; далее gateway |
| `render_export` | `{ render_id, save_path }` | скрипт `render_assets` |
| `undo` | `{}` | хост |
| `ask_user` | `{ questions: [{ question, options?, multi? }] }` | окно показывает карточку |

## 3. Gateway ↔ модель (MCP)

Как в Stultus: MCP-сервер `stultus` по адресу
`http://127.0.0.1:<port>/mcp/<connection-id>` с bearer-пропуском, уникальным
для соединения. Инструменты: `execute_python`, `get_scene`, `select`,
`take_screenshot`, `render_viewport`, `named_views`, `grasshopper`,
`save_recipe`, `get_recipe`, `undo`, `ask_user`. Каждый вызов — `tool_call` по WebSocket и
ожидание `tool_result` (`TOOL_TIMEOUT_MS`, 10 минут); модель ждёт ответа
инструмента до `MCP_TOOL_TIMEOUT_MS` (45 минут — большой кадр 8K).

## 4. HTTP gateway

| Путь | Что |
|---|---|
| `GET /health` | `{ name, version, host_min, package, image_generation, windows[], providers[] }` |
| `GET /ui/` → `/ui/index.html` | окно; `app.js`, `render.js`, `ui.js`, css, svg |
| `GET /ui/tools.js` | Python-скрипты инструментов |
| `GET /download/<файл>.yak` | пакеты хоста из `PACKAGES_DIR` |
| `POST /mcp/<id>` | MCP для процесса модели (только localhost, bearer) |
| `/ws` | WebSocket окон |
