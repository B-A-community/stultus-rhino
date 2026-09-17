import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Codex } from '@openai/codex-sdk'
import { config } from '../config.ts'
import type { PluginConnection } from '../connection.ts'
import { MCP_SERVER_NAME, TOOL_NAMES } from '../mcp.ts'
import { agentsMd } from '../prompt.ts'
import type { Piece, RunInput } from './pieces.ts'

/**
 * Codex через @openai/codex-sdk (обёртка над codex CLI).
 *
 * Системной подсказки у Codex как параметра нет: он читает AGENTS.md из
 * рабочего каталога. Поэтому gateway держит каталог с этим файлом и
 * запускает треды в нём. Инструменты плагина подключены как MCP-сервер
 * по HTTP с bearer-пропуском из переменной окружения.
 *
 * Песочница read-only, одобрения отключены: команд оболочки модели не
 * нужно, а MCP-инструменты песочницей не ограничиваются.
 */
export function codexConfigured(): boolean {
  if (config.codexApiKey) return true
  return existsSync(join(config.codexHome, 'auth.json'))
}

function ensureWorkDir(): string {
  const dir = join(config.workDir, 'codex')
  mkdirSync(dir, { recursive: true })
  const agents = join(dir, 'AGENTS.md')
  writeFileSync(agents, agentsMd())
  return dir
}

export async function* runCodex(conn: PluginConnection, input: RunInput): AsyncGenerator<Piece> {
  const workingDirectory = ensureWorkDir()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (config.codexApiKey) env.CODEX_API_KEY = config.codexApiKey
  if (config.codexHome) env.CODEX_HOME = config.codexHome
  env.STULTUS_MCP_TOKEN = conn.mcpToken

  const codex = new Codex({
    env,
    config: {
      mcp_servers: {
        [MCP_SERVER_NAME]: {
          url: conn.mcpUrl,
          bearer_token_env_var: 'STULTUS_MCP_TOKEN',
          tool_timeout_sec: Math.ceil(config.mcpToolTimeoutMs / 1000),
          // Без этого Codex при approvalPolicy=never отклоняет каждый
          // пишущий инструмент: «MCP tool call requires approval, but approval
          // policy is never» — execute_python не доходил до плагина. «auto»
          // не помогает (решает по аннотациям, а execute_python пишущий), нужен
          // «approve». Одобрять здесь некому: решение о снимке принимает
          // сам плагин, остальное и есть работа модели.
          default_tools_approval_mode: 'approve',
          tools: Object.fromEntries(TOOL_NAMES.map((t) => [t, { approval_mode: 'approve' }])),
        },
      },
    },
  })

  const options = {
    model: input.model,
    workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only' as const,
    approvalPolicy: 'never' as const,
    webSearchEnabled: false,
  }
  const thread = input.resume ? codex.resumeThread(input.resume, options) : codex.startThread(options)

  // Картинки: Codex принимает только файлы — кладём оригиналы во временную папку хода.
  const attachments = input.attachments ?? []
  let userInput: string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = input.prompt
  let tempDir: string | null = null
  if (attachments.length) {
    tempDir = mkdtempSync(join(tmpdir(), 'stultus-att-'))
    const parts: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = []
    attachments.forEach((a, i) => {
      const ext = a.mime === 'image/jpeg' ? '.jpg' : a.mime === 'image/webp' ? '.webp' : a.mime === 'image/gif' ? '.gif' : '.png'
      const path = join(tempDir!, `${i + 1}${ext}`)
      writeFileSync(path, Buffer.from(a.base64, 'base64'))
      parts.push({ type: 'local_image', path })
    })
    parts.push({ type: 'text', text: `${input.prompt}\n\n[Приложено изображений: ${attachments.length} — ${attachments.map((a) => a.name).join(', ')}]` })
    userInput = parts
  }
  const { events } = await thread.runStreamed(userInput, { signal: input.signal })

  const texts = new Map<string, string>()
  let lastMessageId: string | null = null
  for await (const event of events) {
    if (input.signal.aborted) break
    switch (event.type) {
      case 'thread.started':
        yield { kind: 'session', id: event.thread_id }
        break
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = event.item
        if (item.type === 'agent_message') {
          // Codex отдаёт каждый абзац отдельным сообщением без разделителя —
          // склеенные «мм.Сцена уже» читались как одно предложение.
          if (lastMessageId !== null && lastMessageId !== item.id && item.text) {
            yield { kind: 'text', text: '\n\n' }
          }
          lastMessageId = item.id
          const prev = texts.get(item.id) ?? ''
          if (item.text.startsWith(prev)) {
            const delta = item.text.slice(prev.length)
            if (delta) yield { kind: 'text', text: delta }
          } else {
            yield { kind: 'text_replace', text: item.text }
          }
          texts.set(item.id, item.text)
        } else if (item.type === 'reasoning') {
          // Codex отдаёт размышление целиком по завершении; пока думает — статус.
          if (event.type === 'item.completed' && item.text) yield { kind: 'thinking', text: item.text }
          else if (event.type === 'item.started') yield { kind: 'status', text: 'модель думает…' }
        } else if (item.type === 'error') {
          throw new Error(`Codex: ${item.message}`)
        }
        break
      }
      case 'turn.completed': {
        if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = null }
        const u = event.usage
        yield {
          kind: 'usage',
          usage: {
            input: (u?.input_tokens ?? 0) + (u?.cached_input_tokens ?? 0),
            output: u?.output_tokens ?? 0,
            cached: u?.cached_input_tokens ?? 0,
          },
        }
        break
      }
      case 'turn.failed':
        throw new Error(`Codex: ${event.error?.message ?? 'ход не удался'}`)
      case 'error':
        throw new Error(`Codex: ${event.message}`)
    }
  }
}
