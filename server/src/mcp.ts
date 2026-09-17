import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { PluginConnection } from './connection.ts'
import { getRecipe, listRecipes, saveRecipe } from './recipes.ts'
import { randomUUID } from 'node:crypto'
import { pngImage, renderConfigured, renderViewport, type RenderImage } from './render.ts'
import { LARGE_SIZES, SIZE_IDS, largeSize, largeSizeList, renderLarge } from './tiles.ts'
import { VERSION } from './version.ts'

/**
 * MCP-сервер «stultus» — инструменты одного окна Rhino.
 *
 * Модель (процесс Claude Code или Codex на этой же машине) ходит сюда по
 * Streamable HTTP: POST /mcp/<connection-id> с bearer-пропуском соединения.
 * Каждый инструмент — это запрос плагину по WebSocket и ожидание ответа.
 *
 * Без сессий MCP (stateless): на каждый запрос новый сервер и транспорт.
 * Состояния между вызовами нет — держать сессии незачем, а без них не
 * бывает «протухших» сессий после перезапуска.
 */
export const MCP_SERVER_NAME = 'stultus'

/** Что модель называет в описаниях — единый источник для обоих провайдеров. */
export const TOOL_NAMES = ['execute_python', 'get_scene', 'select', 'take_screenshot', 'render_viewport', 'named_views', 'save_recipe', 'get_recipe', 'undo', 'ask_user'] as const

function build(conn: PluginConnection): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: VERSION })

  server.registerTool('render_viewport', {
    title: 'Визуализация текущего кадра',
    description: 'Создаёт постпродакшн-картинку из точно выставленного пользователем вьюпорта Rhino. ' +
      'Плагин попросит согласие, зафиксирует текущий кадр и передаст его встроенному генератору Codex. ' +
      'Камера, выделение и геометрия не меняются. Результат появляется в чате с исходником и кнопкой сохранения. ' +
      'Используй только по просьбе сделать визуализацию/рендер/постпродакшн. Не вызывай select с zoom или ' +
      'execute_python перед этим: ракурс уже выбрал пользователь. Не нужен отдельный take_screenshot.',
    inputSchema: {
      prompt: z.string().trim().min(1).max(6000).describe('Пожелания к свету, материалам и атмосфере; сохранить архитектуру и ракурс'),
      size: z.enum(SIZE_IDS).optional().describe(
        'normal (по умолчанию) — один кадр ~1,6 мегапикселя, около минуты. Большие кадры собираются из плиток ' +
        'и стоят генераций и минут: ' + largeSizeList().map(s => `${s.id} — ${s.width} px по ширине, ${s.generations} генераций`).join('; ') +
        '. Выбирай большой размер только по просьбе (4K, 6K, 8K, 2K → 4k, «большой», «для печати»); у швов плиток возможны артефакты.'),
      save_path: z.string().trim().max(500).optional().describe(
        'Куда сохранить готовый кадр на компьютере пользователя: файл .png или папка (создаётся; имя файла подставится). ' +
        'Передавай, если пользователь назвал место. Без него кадр остаётся в чате с кнопкой «Сохранить PNG».'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ prompt, size, save_path }) => {
    const id = randomUUID(), signal = conn.running?.signal
    try {
      if (!renderConfigured()) throw new Error('Генерация ещё не подключена: нужен вход Codex на gateway и RENDER_ENABLED=1.')
      if (!signal || signal.aborted) throw new Error('Визуализация доступна только в активном ходе пользователя.')
      const shot = await conn.callTool('render_viewport', { prompt, render_id: id, size: size ?? 'normal', sizes: largeSizeList(), save_path: save_path || '' })
      if (!shot.ok || !shot.image) return { content: [{ type: 'text' as const, text: shot.content || 'Пользователь не разрешил визуализацию.' }], isError: !shot.ok }
      signal.throwIfAborted()
      if (shot.capture?.framing !== 'viewport') throw new Error('Обновите плагин: снимок должен сохранять кадрирование вьюпорта.')
      const source = pngImage(shot.image.base64)
      // Пользователь мог поправить задание и размер в карточке — генерируем по его выбору.
      const finalPrompt = (shot.prompt ?? '').trim().slice(0, 6000) || prompt
      const edited = finalPrompt !== prompt
      const large = largeSize(shot.size)
      let shown: RenderImage, sourceShown = source, note = '', width: number, height: number
      if (large) {
        const label = LARGE_SIZES[large].label
        const result = await renderLarge(large, source, finalPrompt, signal, text => conn.send({ type: 'render_status', id, text: `Большой кадр ${label}: ${text}` }))
        signal.throwIfAborted()
        shown = result.preview; sourceShown = result.source; width = result.width; height = result.height
        // Превью в ленту сразу, полный файл — кусками следом: окно пишет их на диск.
        const CHUNK = 2 * 1024 * 1024
        const chunks = Math.ceil(result.file.length / CHUNK)
        conn.send({ type: 'render_result', id, prompt: finalPrompt, source: sourceShown, image: shown, large: true, full: { width, height, bytes: result.file.length, chunks } })
        for (let i = 0; i < chunks; i++) conn.send({ type: 'render_chunk', id, index: i, total: chunks, data: result.file.subarray(i * CHUNK, (i + 1) * CHUNK).toString('base64') })
        note = ` Это «большой кадр» ${label} из плиток (${result.generations} генераций, плитки пустого фона взяты из эталона): у швов плиток возможны двоение кромок и разница тона, предупреди пользователя и предложи проверить стыки крупно. Тебе показано уменьшенное превью, полный файл сохранён у пользователя.`
      } else {
        conn.send({ type: 'render_status', id, text: 'Создаю визуализацию. Это может занять несколько минут…' })
        const image = await renderViewport(source, finalPrompt, signal); shown = image; width = image.width; height = image.height
        signal.throwIfAborted()
        conn.send({ type: 'render_result', id, prompt: finalPrompt, source: sourceShown, image })
      }
      // Окно подтверждает, что файл целиком лёг на диск, и копирует его по save_path.
      const exported = await conn.callTool('render_export', { render_id: id, save_path: save_path || '' })
      const changedRatio = Math.abs(width / height / (source.width / source.height) - 1) > 0.02
      return { content: [
        { type: 'text' as const, text: `Постпродакшн-кадр ${width}×${height} показан пользователю. Исходник ${source.width}×${source.height}. Геометрия Rhino не менялась. Это ИИ-визуализация: сравни её с исходником, не обещай точность геометрии.` + note + ` ${exported.content}` + (changedRatio ? ' Формат результата отличается от исходного — сообщи пользователю.' : '') + (edited ? ` Пользователь изменил задание, генерация шла по его тексту: «${finalPrompt}».` : '') },
        { type: 'image' as const, data: shown.base64, mimeType: shown.mime },
      ] }
    } catch (error) {
      const text = signal?.aborted ? 'Визуализация остановлена.' : error instanceof Error ? error.message : String(error)
      conn.send({ type: 'render_status', id, text, failed: true })
      return { content: [{ type: 'text' as const, text }], isError: true }
    }
  })

  server.registerTool(
    'execute_python',
    {
      title: 'Выполнить Python в Rhino',
      description:
        'Исполняет Python 3 (CPython, rhinoscriptsyntax + RhinoCommon) в открытом документе Rhino. ' +
        'Возвращает stdout (print) и значение переменной result, если ты её присвоил (JSON-сериализуемое). ' +
        'Весь вызов — одна запись Undo; ошибка откатывает всё, что успел сделать код. Длины — в единицах ' +
        'документа (см. units в снимке сцены). Код исполняется на главном потоке и не прерывается — ' +
        'дроби тяжёлое на части, не пиши скрипты длиннее ~150 строк. Не открывай диалогов и не жди ввода.',
      inputSchema: {
        code: z.string().describe('Python-код'),
        label: z.string().max(60).optional().describe('Короткое имя действия для пункта Undo, по-русски'),
      },
    },
    async ({ code, label }) => {
      const r = await conn.callTool('execute_python', { code, label })
      return { content: [{ type: 'text', text: r.content }], isError: !r.ok }
    },
  )

  server.registerTool(
    'get_scene',
    {
      title: 'Снимок сцены',
      description:
        'Краткое состояние открытого документа Rhino: единицы, ТЕКУЩЕЕ ВЫДЕЛЕНИЕ пользователя (подробно: ' +
        'тип, имя, слой, габарит; для экземпляров блоков — сколько всего экземпляров у определения), ' +
        'объекты верхнего уровня (id, тип, имя, слой, материал, габарит), слои, материалы, блоки, именованные ' +
        'виды, активный вьюпорт и камера. Список объектов ограничен; глубже — через execute_python.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const r = await conn.callTool('get_scene', {})
      return { content: [{ type: 'text', text: r.content }], isError: !r.ok }
    },
  )

  server.registerTool(
    'select',
    {
      title: 'Выделить объекты',
      description:
        'Меняет выделение в Rhino: выделяет объекты по их id (GUID из get_scene или execute_python), ' +
        'добавляет к текущему или снимает выделение. С zoom камера наводится на выделенное. ' +
        'Используй, чтобы показать пользователю результат или спросить «вы имели в виду вот эти?».',
      inputSchema: {
        ids: z.array(z.string()).max(2000).optional().describe('GUID объектов'),
        mode: z.enum(['replace', 'add', 'clear']).optional().describe('replace (по умолчанию), add, clear'),
        zoom: z.boolean().optional().describe('Навести камеру на выделенное'),
      },
    },
    async ({ ids, mode, zoom }) => {
      const r = await conn.callTool('select', { ids: ids ?? [], mode: mode ?? 'replace', zoom: zoom ?? false })
      return { content: [{ type: 'text', text: r.content }], isError: !r.ok }
    },
  )

  server.registerTool(
    'take_screenshot',
    {
      title: 'Снимок вьюпорта',
      description:
        'Просит у пользователя снимок активного вьюпорта Rhino. Пользователь увидит твою причину и нажмёт ' +
        '«Сделать снимок» или «Отказать». Снимок приходит картинкой. Можно попросить стандартный вид ' +
        'и «показать всё» — камера пользователя после снимка вернётся на место. Можно указать режим ' +
        'отображения (shaded, rendered, arctic…). Проси, когда нужно проверить форму или компоновку; отказ — не ошибка.',
      inputSchema: {
        reason: z.string().describe('Зачем нужен снимок, одной фразой по-русски'),
        view: z.enum(['current', 'perspective', 'top', 'front', 'right', 'back', 'left', 'bottom']).optional().describe('Ракурс; по умолчанию текущий'),
        zoom_extents: z.boolean().optional().describe('Показать всю модель в кадре'),
        display_mode: z.string().max(40).optional().describe('Режим отображения по английскому имени: Wireframe, Shaded, Rendered, Ghosted, Arctic, Pen, Technical…; по умолчанию текущий'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ reason, view, zoom_extents, display_mode }) => {
      const r = await conn.callTool('take_screenshot', { reason, view: view === 'current' ? undefined : view, zoom_extents, display_mode })
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text: r.content },
      ]
      if (r.image) content.push({ type: 'image', data: r.image.base64, mimeType: r.image.mime })
      return { content, isError: !r.ok }
    },
  )

  server.registerTool(
    'named_views',
    {
      title: 'Именованные виды Rhino',
      description:
        'Именованные виды документа (Named Views): list — перечислить; activate — восстановить вид в активный ' +
        'вьюпорт (камера, проекция); add — сохранить текущий вид под именем; update — обновить вид текущей ' +
        'камерой; delete — удалить. Для серии снимков: activate каждый вид, затем take_screenshot.',
      inputSchema: {
        action: z.enum(['list', 'activate', 'add', 'update', 'delete']),
        name: z.string().max(200).optional().describe('Имя вида (кроме list)'),
      },
    },
    async ({ action, name }) => {
      const r = await conn.callTool('named_views', { action, name })
      return { content: [{ type: 'text', text: r.content }], isError: !r.ok }
    },
  )

  server.registerTool(
    'save_recipe',
    {
      title: 'Сохранить приём в копилку',
      description:
        'Сохраняет проверенный приём (универсальный Python-код с параметрами) в общую копилку бюро. ' +
        'Только по просьбе пользователя «запомнить», после опроса через ask_user о параметрах и названии. ' +
        'Код — Python для execute_python с плейсхолдерами {{имя_параметра}}; в описании — когда приём подходит.',
      inputSchema: {
        name: z.string().min(2).max(80).describe('Короткое имя по-русски, например «Лестница двухмаршевая»'),
        description: z.string().min(5).max(600).describe('Что делает и когда применять'),
        params: z
          .array(z.object({
            name: z.string().min(1).max(40).describe('имя плейсхолдера без скобок'),
            description: z.string().max(200).optional(),
            default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          }))
          .max(20)
          .optional(),
        code: z.string().min(10).max(20000).describe('Python-код с {{плейсхолдерами}}'),
        tags: z.array(z.string().max(30)).max(8).optional(),
      },
    },
    async ({ name, description, params, code, tags }) => {
      const r = saveRecipe({ name, description, params: params ?? [], code, tags: tags ?? [] })
      conn.send({ type: 'recipes', recipes: listRecipes() })
      return { content: [{ type: 'text', text: `Приём «${r.name}» сохранён в копилке (id ${r.id}). Всего приёмов: ${listRecipes().length}.` }] }
    },
  )

  server.registerTool(
    'get_recipe',
    {
      title: 'Взять приём из копилки',
      description: 'Возвращает полный приём (описание, параметры, Python-код с плейсхолдерами) по имени. Подставь значения и выполни через execute_python.',
      inputSchema: { name: z.string().min(1).max(80) },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const r = getRecipe(name)
      if (!r) return { content: [{ type: 'text', text: `Приёма «${name}» нет. Есть: ${listRecipes().map((x) => x.name).join(', ') || 'копилка пуста'}.` }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify({ name: r.name, description: r.description, params: r.params, code: r.code, tags: r.tags }, null, 1) }] }
    },
  )

  server.registerTool(
    'undo',
    {
      title: 'Отменить',
      description: 'Отменяет последнюю операцию в Rhino (в том числе твой последний execute_python).',
      inputSchema: {},
    },
    async () => {
      const r = await conn.callTool('undo', {})
      return { content: [{ type: 'text', text: r.content }], isError: !r.ok }
    },
  )

  server.registerTool(
    'ask_user',
    {
      title: 'Спросить пользователя',
      description:
        'Задать пользователю ВСЕ уточняющие вопросы одним вызовом и закончить ход. У каждого вопроса ' +
        '2–4 варианта с конкретными значениями (размеры в единицах документа, материалы, места); пользователь может ' +
        'выбрать вариант или написать свой. Ответы на все вопросы придут одним следующим сообщением. ' +
        'Используй до первого изменения модели, когда не хватает размера, места, количества или ' +
        'смысла — не угадывай. Не задавай вопросы по одному в разных ходах.',
      inputSchema: {
        questions: z
          .array(
            z.object({
              question: z.string().min(1).max(300).describe('Вопрос по-русски'),
              options: z.array(z.string().min(1).max(80)).max(6).optional().describe('Варианты ответа кнопками'),
              multi: z.boolean().optional().describe('Можно выбрать несколько вариантов'),
            }),
          )
          .min(1)
          .max(8)
          .optional()
          .describe('Список вопросов — задавай все нужные сразу'),
        // Старая форма — один вопрос; оставлена для совместимости.
        question: z.string().optional(),
        options: z.array(z.string()).max(6).optional(),
      },
    },
    async ({ questions, question, options }) => {
      const list = questions?.length ? questions : question ? [{ question, options }] : []
      if (!list.length) return { content: [{ type: 'text', text: 'Нет вопросов: передай questions[].' }], isError: true }
      const r = await conn.callTool('ask_user', { questions: list })
      return { content: [{ type: 'text', text: r.content }], isError: !r.ok }
    },
  )

  return server
}

/** Обработать один HTTP-запрос к MCP этого соединения. */
export async function handleMcp(conn: PluginConnection, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${conn.mcpToken}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  const server = build(conn)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
