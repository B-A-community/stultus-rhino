/**
 * Настройки gateway — только из окружения. На виртуалке всё задаётся в
 * /opt/stultus-rhino/.env (см. deploy/), в репозиторий файл не попадает.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ModelChoice { id: string; label?: string }

/**
 * Список моделей из .env: `id` или `id:Подпись` через запятую. Подпись
 * показывает окно плагина вместо идентификатора.
 */
export function parseModels(text: string): ModelChoice[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':')
      return i > 0 ? { id: s.slice(0, i).trim(), label: s.slice(i + 1).trim() || undefined } : { id: s }
    })
}

/** Корень пакета сервера (где package.json): оттуда раздаются ui/ и rhino/. */
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const config = {
  /** Порт: и WebSocket для плагинов, и MCP для моделей, и окно (/ui/), и проверка здоровья. */
  port: Number(process.env.PORT ?? 8792),
  /** Адрес, на котором слушать: за Caddy/nginx на VPS — 127.0.0.1, в локальной сети — 0.0.0.0. */
  host: process.env.HOST ?? '0.0.0.0',

  /**
   * Пропуск для плагинов. Пустой — никто не подключится.
   *
   * Закрыто по умолчанию намеренно: gateway слушает на всю локальную сеть, а
   * через него исполняется произвольный Python в Rhino сотрудников.
   */
  pluginToken: process.env.PLUGIN_TOKEN ?? '',

  /**
   * Адрес, по которому МОДЕЛЬ (процесс Claude Code / Codex на этой же
   * машине) достучится до MCP-эндпоинта gateway. Это всегда localhost:
   * наружу MCP не выставляется.
   */
  mcpBase: process.env.MCP_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8792}`,

  /**
   * Окно плагина и скрипты инструментов раздаются отсюда (/ui/). Плагин в
   * Rhino — тонкий хост, всё, что меняется часто, приезжает с сервера.
   */
  uiDir: process.env.UI_DIR ?? resolve(serverRoot, 'ui'),
  /** Python-скрипты инструментов плагина: собираются в /ui/tools.js. */
  rhinoDir: process.env.RHINO_DIR ?? resolve(serverRoot, 'rhino'),
  /** Пакеты плагина (.yak) для обновления хоста: /download/<файл>. */
  packagesDir: process.env.PACKAGES_DIR ?? `${process.cwd()}/data/packages`,

  /**
   * Вход для Claude Agent SDK. `CLAUDE_CODE_OAUTH_TOKEN` — подписка
   * (`claude setup-token`), `ANTHROPIC_API_KEY` — ключ API. Ни того ни
   * другого — провайдер помечается ненастроенным, окно плагина скажет об этом.
   */
  claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  /**
   * Считать Claude настроенным без токена в окружении: на машине выполнен
   * `claude login`, и CLI хранит вход сам (на Windows — в хранилище
   * учётных данных, файла .credentials.json нет). Для локальной разработки.
   */
  claudeAssumeLoggedIn: process.env.CLAUDE_ASSUME_LOGGED_IN === '1',
  /**
   * Путь к исполняемому Claude Code вместо встроенного в SDK. Нужен там,
   * где вход выполнен в установленный CLI, а не в SDK-шный бинарник: у них
   * разные хранилища учётных данных, и SDK отвечает «Not logged in».
   */
  claudeCodePath: process.env.CLAUDE_CODE_PATH ?? '',
  claudeModels: parseModels(process.env.CLAUDE_MODELS ?? 'claude-opus-5:Opus 5,claude-sonnet-5:Sonnet 5,claude-haiku-4-5:Haiku 4.5'),
  claudeDefaultModel: process.env.CLAUDE_DEFAULT_MODEL ?? 'claude-opus-5',

  /**
   * Вход для Codex. `CODEX_API_KEY` — ключ; либо `codex login` на этой
   * машине (auth.json в CODEX_HOME). Настроенность проверяется по факту:
   * ключ есть или файл auth.json есть.
   */
  codexApiKey: process.env.CODEX_API_KEY ?? '',
  codexHome: process.env.CODEX_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.codex`,
  // Список от `codex app-server` (model/list, 2026-09-17): gpt-6-astra, gpt-5.6-sol,
  // gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2. Подписи — как их зовут в бюро.
  codexModels: parseModels(process.env.CODEX_MODELS ?? 'gpt-6-astra:GPT-6 Astra · Топовая,gpt-5.6-sol:GPT-5.6 Sol · Мощная,gpt-5.6-terra:GPT-5.6 Terra · Средняя,gpt-5.6-luna:GPT-5.6 Luna · Слабая'),
  codexDefaultModel: process.env.CODEX_DEFAULT_MODEL ?? 'gpt-6-astra',

  /** Постпродакшн через встроенную генерацию картинок Codex (вход ChatGPT), отдельно от провайдера чата. */
  renderEnabled: process.env.RENDER_ENABLED === '1',
  renderCodexPath: process.env.RENDER_CODEX_PATH ?? '',
  renderModel: process.env.RENDER_MODEL ?? '',
  renderTimeoutMs: Number(process.env.RENDER_TIMEOUT_MS ?? 10 * 60 * 1000),

  /**
   * «Большой кадр»: встроенный генератор Codex отдаёт ~1,6 мегапикселя и
   * размер входа игнорирует, поэтому 4K/6K/8K собираются из плиток: эталон
   * целиком, потом каждая плитка исходника дорисовывается по эталону, и всё
   * сшивается с плавным нахлёстом (размеры и сетки — в tiles.ts). Доля
   * нахлёста от плитки; запас времени на одну генерацию для общего таймаута;
   * RENDER_KEEP_LAST=1 оставляет последний собранный кадр на сервере в
   * WORK_DIR/renders/last-large.png для разбора швов.
   */
  renderLargeOverlap: Number(process.env.RENDER_LARGE_OVERLAP ?? 0.12),
  renderLargePerGenerationMs: Number(process.env.RENDER_LARGE_PER_GENERATION_MS ?? 3 * 60 * 1000),
  renderKeepLast: process.env.RENDER_KEEP_LAST === '1',

  /**
   * Потолок кругов «инструмент → ответ» на один ход. Страховка от
   * зацикливания, а не бюджет: цикл «построил → посмотрел → поправил»
   * требует десятков кругов.
   */
  maxTurns: Number(process.env.MAX_TURNS ?? 150),

  /** Сколько ждать ответа плагина на вызов инструмента, мс. execute_python на большой модели — минуты. */
  toolTimeoutMs: Number(process.env.TOOL_TIMEOUT_MS ?? 10 * 60 * 1000),
  /**
   * Сколько модель (Codex/Claude) ждёт ответа нашего MCP-инструмента, мс.
   * Отдельно от таймаута плагина: «большой кадр» 8K — 19 генераций, около
   * 15 минут внутри одного вызова render_viewport.
   */
  mcpToolTimeoutMs: Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 45 * 60 * 1000),

  /** Рабочий каталог для процессов моделей (там же AGENTS.md для Codex). */
  workDir: process.env.WORK_DIR ?? `${process.cwd()}/data/work`,

  /** Файл копилки приёмов (общий для бюро). */
  recipesPath: process.env.RECIPES_PATH ?? `${process.cwd()}/data/recipes.json`,

  /**
   * Мягкий ограничитель расхода на один ход, токенов (ввод + вывод, с кэшем).
   * По достижении ход прерывается вопросом «продолжать?». 0 — без лимита.
   * Пока только для Claude: Codex отдаёт расход лишь по концу хода.
   */
  turnTokenBudget: Number(process.env.TURN_TOKEN_BUDGET ?? 400_000),

  /**
   * Предел вызовов инструментов за один ход — для Codex (расход он сообщает
   * только по концу хода) и как вторая страховка для Claude. По достижении
   * ход прерывается вопросом «продолжать?». 0 — без предела.
   */
  turnMaxToolCalls: Number(process.env.TURN_MAX_TOOL_CALLS ?? 60),
}
