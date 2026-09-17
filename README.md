# Stultus Rhino

Плагин Rhinoceros 8 для работы с нейросетью прямо в открытом документе: чат
в окне плагина, модель (Claude Code или Codex) строит и правит геометрию
через Python (RhinoCommon), видит состояние сцены и — с вашего согласия —
снимок вьюпорта. Родной брат [Stultus](https://github.com/B-A-community/stultus)
для SketchUp: тот же gateway, тот же дизайн окна, те же инструменты.

Версия 0.1.0 · лицензия [Apache 2.0](LICENSE) · © 2026 B&A community

Создатели: [maksarsanjeev](https://github.com/maksarsanjeev) — см. [AUTHORS](AUTHORS).

## Главное отличие от Stultus для SketchUp

**Плагин в Rhino — тонкий хост, всё остальное приезжает с сервера.**
Окно чата (HTML/JS), Python-скрипты инструментов и подсказка модели живут
на gateway и отдаются плагину при открытии окна. Обновили сервер —
обновилось окно и инструменты у всех сотрудников сразу, ничего
переустанавливать не надо. Сам хост (C#, .NET 8) меняется редко; когда
это всё же нужно, gateway сообщает окну «плагин устарел», и хост скачивает
и ставит новый пакет `.yak` сам — остаётся перезапустить Rhino.

## Что делает

Пишете в окне «сделай лестницу от этой площадки до отметки +3000, ширина
1000» — модель читает снимок документа, пишет Python, исполняет его в Rhino,
перечитывает результат и отвечает. Весь ход модели — **один пункт Undo**:
не понравилось — Ctrl+Z.

- **Два провайдера** на выбор в окне: Claude (через Claude Agent SDK) и
  Codex (через codex CLI; модели GPT-6 Astra, GPT-5.6 Sol/Terra/Luna). Ключи
  и подписки живут на общем сервере, на рабочих машинах их нет.
- **Выделение — главный контекст.** Что выделено в Rhino, видно в строке
  под полем ввода («3 экземпляра блока «Окно» из 20, 1 полисурфейс: Стена»)
  и уходит с каждым сообщением. «Переделай это» относится только к
  выделенному. Для экземпляра блока модель знает, сколько всего экземпляров.
- **Сцена в запросе.** По галочке к сообщению прикладывается компактный
  снимок документа: единицы, объекты верхнего уровня с габаритами, слои,
  материалы, блоки, группы, именованные виды, камера.
- **Снимок вьюпорта только по кнопке.** Модель просит и объясняет зачем, вы
  разрешаете или отказываете. Можно попросить стандартный вид, «показать
  всё» и режим отображения (Shaded, Rendered, Arctic…) — камера после
  снимка вернётся на место.
- **Переписка в файле модели.** Хранится в пользовательском тексте
  документа (секция `BACommunity_StultusRhino`), лимит 150 КБ, картинки не
  пишутся. Открыли `.3dm` через неделю — разговор на месте, модель продолжит
  с того же места, пока сервер помнит сессию. «Удалить историю» убирает
  переписку в архив, «Восстановить» возвращает.
- **Постпродакшн текущего вида.** «Сделай визуализацию: вечерний свет,
  бетон и стекло» — кадр вьюпорта уходит в генератор картинок Codex и
  возвращается презентационным кадром с сохранённым ракурсом; большой кадр
  4K/6K/8K собирается из плиток. Включается на gateway (`RENDER_ENABLED=1`).
- **Копилка приёмов бюро.** Удачное построение по кнопке «Запомнить приём»
  становится параметризованным Python-скриптом на сервере; модель обязана
  применять подходящий приём вместо своего кода.
- **Картинки в сообщении**: скрепка, Ctrl+V, перетаскивание; оригиналы
  ложатся в папку `<файл>-content` рядом с `.3dm`.

Инструменты модели: `execute_python`, `get_scene`, `select`,
`take_screenshot`, `render_viewport`, `named_views`, `save_recipe`,
`get_recipe`, `undo`, `ask_user`. Подробно — [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Статус

Тестовая сборка 0.1.0. Проверено на живом Rhino 8.30 (Windows) и gateway:
Codex GPT-6 Astra строит куб по описанию (execute_python → select →
get_scene), просит и получает снимок вьюпорта, продолжает сессию между
ходами; весь ход откатывается одним Undo; переписка ложится в документ.
Релиза нет: пакет `.yak` собирается локально (`tools\build_yak.ps1`) и
раздаётся напрямую или через gateway.

## Как устроено

```
Rhino 8 + хост (C#, .NET 8)  ──WebView2──  окно чата (HTML/JS с gateway: /ui/)
       ▲ python(code, args)      │ receive          │ WebSocket, исходящий (тот же адрес)
       │ Python 3 через RhinoCode                   ▼
       │                                  gateway (Node 24, Docker на виртуалке бюро)
       │  скрипты инструментов ◄──────────  /ui/tools.js (rhino/*.py)
                                                    │ MCP по localhost
                                                    ▼
                                          Claude Code / Codex (процесс на виртуалке)
```

Хост умеет пять вещей: показать страницу с gateway, исполнить присланный
Python на главном потоке Rhino, держать одну запись Undo на ход, хранить
переписку в документе и настройки на рабочем месте, обновить сам себя.
Всё, что делает модель с документом — снимок сцены, выделение, снимок
вьюпорта, именованные виды, вложения — это Python-скрипты из
`server/rhino/`, которые окно получает с сервера и передаёт хосту.
Архитектура — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Установка

Пошаговая инструкция — [docs/DEPLOY.md](docs/DEPLOY.md).

### Gateway (виртуалка бюро)

```bash
sudo mkdir -p /opt/stultus-rhino/{claude,codex,data} && sudo chown -R $USER /opt/stultus-rhino
git clone https://github.com/B-A-community/stultus-rhino.git /opt/stultus-rhino/app
cp /opt/stultus-rhino/app/server/deploy/.env.example /opt/stultus-rhino/.env   # PLUGIN_TOKEN, вход к моделям
cd /opt/stultus-rhino/app/server && docker compose -f deploy/docker-compose.yml up -d --build
curl http://localhost:8792/health
```

Вход к моделям: Claude — `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`)
или файл `.credentials.json` в томе `/opt/stultus-rhino/claude`; Codex —
`CODEX_API_KEY` или `auth.json` после `codex login` в томе
`/opt/stultus-rhino/codex`.

### Плагин (рабочая машина)

1. Собрать: `powershell -ExecutionPolicy Bypass -File tools\build_yak.ps1` →
   `build\stultus-rhino-0.1.0-rh8_0-any.yak` (нужен .NET 8 SDK). Или взять
   готовый пакет у того, кто собирал, или с gateway: `http://<сервер>:8792/download/<пакет>.yak`.
2. Rhino 8 → `_PackageManager` → Install from file (либо `yak install
   <файл>` из `C:\Program Files\Rhino 8\System`) → перезапустить Rhino.
3. Команда `Stultus` открывает окно. В первый раз оно спросит адрес сервера
   (`http://<сервер>:8792`) и пропуск — они хранятся на этом компьютере, в
   файлы моделей не попадают. Дальше окно грузится с сервера.

Для разработки: `dotnet build -c Release` в `host\`, затем
`tools\dev_install.ps1` регистрирует `host\bin\Release\StultusRhino.rhp` в
Rhino (реестр), перезапуск Rhino. `STULTUS_RHINO_DEV=1` в окружении Rhino
включает мост разработки на `127.0.0.1:8799` для прогонов из `tests/dev.py`.

## Структура

```
host/StultusRhino.csproj      хост: тонкий плагин Rhino 8 (.NET 8)
host/src/Plugin.cs            регистрация плагина, журнал
host/src/StultusCommand.cs    команды Stultus, StultusSettings
host/src/ChatWindow.cs        окно (Eto Form + WebView2), события документа
host/src/Bridge.cs            мост окно↔Rhino: python, execute_python, undo на ход, переписка, настройки
host/src/PythonRunner.cs      Python 3 через RhinoCode: аргументы, result, stdout, трассировки
host/src/DocStore.cs          переписка/сессии/архив в пользовательском тексте документа
host/src/HostSettings.cs      адрес/пропуск/тема/положение окна в настройках плагина
host/src/HostUpdate.cs        проверка сервера, скачивание и установка .yak
host/src/DevBridge.cs         мост разработки (127.0.0.1:8799), только по STULTUS_RHINO_DEV=1
host/boot/boot.html           страница-заглушка: адрес сервера и пропуск
server/src/                   gateway: index, ui (раздача окна и скриптов), chat, mcp, connection, config, prompt, providers/
server/ui/                    окно чата (дизайн Graphite): index.html, app.js, render.js, css
server/rhino/                 Python-скрипты инструментов: _common, scene_state, select, screenshot, named_views, attachments, render_assets
server/deploy/                Dockerfile, docker-compose.yml, .env.example
docs/                         ARCHITECTURE, PROTOCOL, DEPLOY, USER-GUIDE, AGENT-GUIDE, ROADMAP
tests/dev.py                  прогоны на живом Rhino через мост разработки
tools/build_yak.ps1           сборка пакета; tools/dev_install.ps1 — регистрация для разработки
```

## Грабли

- **Python исполняется на главном потоке Rhino** и не прерывается: долгий
  скрипт держит интерфейс. Модели велено дробить построения; лимита времени
  нет намеренно — прервать CPython посреди вызова RhinoCommon безопасно нельзя.
- **Ошибка внутри вызова не откатывает изменения существующих объектов.**
  Весь ход — одна запись Undo, поэтому откатить один вызов нельзя; хост
  удаляет объекты, созданные упавшим вызовом, и сообщает модели, что правки
  существующих остались. Полный откат — Ctrl+Z после хода.
- **Пока идёт ход, ваши ручные правки попадут в ту же запись Undo.** Ход
  длится секунды-минуты; лучше подождать.
- **Первый вызов Python в сессии Rhino — пара секунд**: RhinoCode
  поднимает CPython 3.9. Дальше мгновенно.
- **Новые параметры инструментов не доходят до старых разговоров**: Claude
  Code держит описания инструментов сессии с первого хода; после обновления
  gateway — «Удалить историю» (новый разговор).
- **Окно грузится с сервера**: если сервер недоступен, хост показывает
  локальную страницу с настройками. Смена адреса — переход на страницу нового
  сервера.
- Сборки Rhino (RhinoCommon, Eto, Rhino.Runtime.Code) берутся из
  установленного Rhino 8 (`RhinoDir` в csproj), в пакет не копируются.

## Лицензия

Apache 2.0, © 2026 B&A community. Полный текст — [LICENSE](LICENSE).
