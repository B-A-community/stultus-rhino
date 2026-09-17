import { randomBytes, randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { config } from './config.ts'

/** Что плагин рассказывает о себе при подключении. */
export interface InstanceInfo {
  app?: string
  app_version?: string
  plugin?: string
  pid?: number
  model_title?: string
  model_path?: string | null
  model_guid?: string
  /** Единицы документа, режим отображения — что хост знает при подключении. */
  units?: string
}

/** Ответ плагина на вызов инструмента. */
export interface ToolResult {
  ok: boolean
  content: string
  image?: { mime: string; base64: string }
  capture?: { framing: string; width: number; height: number }
  /** Текст задания, если пользователь отредактировал его в карточке. */
  prompt?: string
  /** Размер визуализации, выбранный в карточке: normal | large. */
  size?: string
}

/** Сообщения плагин → gateway. */
export type PluginMessage =
  | { type: 'hello'; token?: string; instance?: InstanceInfo; sessions?: Record<string, string> }
  | {
      type: 'chat'
      turn: number
      text: string
      provider: string
      model?: string
      scene?: unknown
      sessions?: Record<string, string>
      /** Картинки пользователя — оригиналы, base64. */
      attachments?: Array<{ name: string; mime: string; base64: string }>
    }
  | { type: 'tool_result'; call_id: string; ok: boolean; content?: string; image?: { mime: string; base64: string }; capture?: ToolResult['capture']; prompt?: string; size?: string }
  | { type: 'cancel' }
  | { type: 'recipe_delete'; id: string }

/** Сообщения gateway → плагин. */
export type GatewayMessage =
  | { type: 'welcome'; version: string; providers: ProviderInfo[]; host_min: string; host_outdated: boolean; package: { name: string; version: string } | null }
  | { type: 'turn_start'; turn: number }
  | { type: 'status'; text: string }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'text_replace'; text: string }
  | { type: 'tool_call'; call_id: string; name: string; args: Record<string, unknown> }
  | { type: 'ask'; question: string; options?: string[] }
  | { type: 'session'; provider: string; id: string }
  | { type: 'done'; usage?: Usage }
  | { type: 'error'; message: string }
  | { type: 'render_status'; id: string; text: string; failed?: boolean }
  | { type: 'recipes'; recipes: import('./recipes.ts').Recipe[] }
  | { type: 'render_result'; id: string; prompt: string; source: import('./render.ts').RenderImage; image: import('./render.ts').RenderImage; large?: boolean; full?: { width: number; height: number; bytes: number; chunks: number } }
  /** Полный большой кадр идёт в окно кусками base64 по порядку; окно дописывает их в файл на диске. */
  | { type: 'render_chunk'; id: string; index: number; total: number; data: string }

export interface ProviderInfo {
  id: string
  label: string
  configured: boolean
  models: Array<{ id: string; label?: string }>
  default: string
}

export interface Usage {
  input: number
  output: number
  cached: number
  cost?: number
}

/**
 * Одно окно Rhino = одно соединение.
 *
 * Держит очередь ожидающих вызовов инструментов: MCP-обработчик кладёт
 * промис, ответ плагина его закрывает. Один ход за раз: пока идёт ход,
 * новое сообщение отклоняется.
 */
export class PluginConnection {
  readonly id = randomUUID()
  /** Пропуск, по которому процесс модели попадает в MCP этого соединения. */
  readonly mcpToken = randomBytes(24).toString('hex')
  instance: InstanceInfo = {}
  sessions: Record<string, string> = {}
  authed = false
  /** Текущий ход — есть ли он и как его прервать. */
  running: { turn: number; cancel: () => void; signal: AbortSignal } | null = null
  toolCalls = 0
  /** Вызовов инструментов в текущем ходе и был ли ход остановлен пределом. */
  turnToolCalls = 0
  budgetStopped = false

  private pending = new Map<string, { resolve: (r: ToolResult) => void; timer: NodeJS.Timeout; cleanup: () => void }>()
  private readonly ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
  }

  get mcpUrl(): string {
    return `${config.mcpBase}/mcp/${this.id}`
  }

  send(message: GatewayMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(JSON.stringify(message))
  }

  /** Попросить плагин выполнить инструмент и дождаться ответа. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const signal = this.running?.signal
    if (signal?.aborted) return Promise.resolve({ ok: false, content: 'Ход остановлен.' })
    this.toolCalls++
    this.turnToolCalls++
    if (config.turnMaxToolCalls > 0 && this.turnToolCalls > config.turnMaxToolCalls && !this.budgetStopped) {
      // Предел вызовов за ход: спрашиваем человека и обрываем ход.
      this.budgetStopped = true
      this.send({
        type: 'ask',
        question: `За этот ход уже ${config.turnMaxToolCalls} вызовов инструментов, работа не закончена. Продолжать?`,
        options: ['Продолжай', 'Хватит, оставь как есть'],
      })
      this.running?.cancel()
      return Promise.resolve({ ok: false, content: 'Предел вызовов за ход исчерпан — пользователь решает, продолжать ли. Закончи ход.' })
    }
    const call_id = randomUUID()
    const started = Date.now()
    const label = typeof args.label === 'string' ? args.label : typeof args.reason === 'string' ? args.reason : ''
    console.log(`[инструмент] ${name}${label ? ` «${label}»` : ''}`)
    return new Promise<ToolResult>((resolve) => {
      const finish = (result: ToolResult) => {
        console.log(`[инструмент] ${name} → ${result.ok ? 'ok' : 'ОШИБКА'} за ${Math.round((Date.now() - started) / 100) / 10} с${result.ok ? '' : `: ${result.content.slice(0, 200)}`}`)
        resolve(result)
      }
      const timer = setTimeout(() => {
        this.resolveTool(call_id, { ok: false, content: `Плагин не ответил за ${Math.round(config.toolTimeoutMs / 1000)} с.` })
      }, config.toolTimeoutMs)
      const onAbort = () => this.resolveTool(call_id, { ok: false, content: 'Ход остановлен.' })
      this.pending.set(call_id, { resolve: finish, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.send({ type: 'tool_call', call_id, name, args })
    })
  }

  /** Ответ плагина на вызов. */
  resolveTool(call_id: string, result: ToolResult): void {
    const entry = this.pending.get(call_id)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.cleanup()
    this.pending.delete(call_id)
    entry.resolve(result)
  }

  /** Соединение закрылось: все ожидающие вызовы получают отказ. */
  dispose(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.cleanup()
      entry.resolve({ ok: false, content: 'Окно Rhino отключилось.' })
    }
    this.pending.clear()
    this.running?.cancel()
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason)
    } catch {
      /* уже закрыто */
    }
  }
}
