import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { config } from '../config.ts'
import type { PluginConnection } from '../connection.ts'
import { MCP_SERVER_NAME } from '../mcp.ts'
import { systemPrompt } from '../prompt.ts'
import type { Piece, RunInput } from './pieces.ts'

/**
 * Claude через Claude Agent SDK — тот же движок, что у Claude Code, только
 * библиотекой внутри gateway. Цикл инструментов крутит SDK; мы отдаём ему
 * MCP-эндпоинт этого окна Rhino и слушаем поток.
 *
 * Встроенные инструменты Claude Code (файлы, оболочка, сеть) не выдаются:
 * модель должна работать с Rhino, а не чинить контейнер.
 */
const BUILT_INS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Agent', 'Task', 'TodoWrite', 'KillShell', 'BashOutput',
]

export function claudeConfigured(): boolean {
  if (config.claudeOauthToken || config.anthropicKey || config.claudeAssumeLoggedIn) return true
  // Вход через `claude login` на этой машине — файл учётных данных CLI.
  return existsSync(join(homedir(), '.claude', '.credentials.json'))
}

export async function* runClaude(conn: PluginConnection, input: RunInput): AsyncGenerator<Piece> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (config.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeOauthToken
  if (config.anthropicKey) env.ANTHROPIC_API_KEY = config.anthropicKey

  // С картинками промпт идёт сообщением с блоками image (оригиналы base64).
  const attachments = input.attachments ?? []
  const prompt = attachments.length
    ? (async function* () {
        yield {
          type: 'user' as const,
          parent_tool_use_id: null,
          message: {
            role: 'user' as const,
            content: [
              ...attachments.map((a) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mime as 'image/png', data: a.base64 } })),
              { type: 'text' as const, text: `${input.prompt}\n\n[Приложено изображений: ${attachments.length} — ${attachments.map((a) => a.name).join(', ')}]` },
            ],
          },
        }
      })()
    : input.prompt

  const run = query({
    prompt,
    options: {
      model: input.model,
      systemPrompt: systemPrompt(),
      // Сводка размышлений — в ленту окна: по умолчанию текст размышлений
      // не возвращается вовсе (display omitted), и строка «думает…» пуста.
      thinking: { type: 'adaptive', display: 'summarized' },
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: conn.mcpUrl,
          headers: { Authorization: `Bearer ${conn.mcpToken}` },
          // Инструментов десять — держим их в подсказке всегда, без отложенной
          // выдачи: иначе модель сначала ищет инструмент, потом строит.
          alwaysLoad: true,
          timeout: config.mcpToolTimeoutMs,
        },
      },
      // Свои инструменты — без вопросов; всё, что попросило бы разрешения
      // (встроенные и чужие), отклоняется: спрашивать здесь некого.
      allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
      disallowedTools: BUILT_INS,
      permissionPrompts: 'none',
      maxTurns: config.maxTurns,
      settingSources: [],
      includePartialMessages: true,
      cwd: config.workDir,
      env,
      ...(config.claudeCodePath ? { pathToClaudeCodeExecutable: config.claudeCodePath } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
    },
  })

  const onAbort = () => {
    void run.interrupt().catch(() => {})
  }
  input.signal.addEventListener('abort', onAbort, { once: true })

  // Мягкий ограничитель: расход копится по сообщениям модели, и при
  // превышении ход прерывается вопросом. Решает человек, а не счётчик.
  let spent = 0
  let budgetStop = false

  try {
    for await (const message of run) {
      if (message.type === 'assistant' && config.turnTokenBudget > 0 && !budgetStop) {
        const u = (message.message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage
        if (u) spent += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        if (spent > config.turnTokenBudget) {
          budgetStop = true
          await run.interrupt().catch(() => {})
          yield {
            kind: 'ask',
            question: `Потрачено ${(spent / 1000).toFixed(0)}k токенов за этот ход — предел ${(config.turnTokenBudget / 1000).toFixed(0)}k. Работа не закончена. Продолжать?`,
            options: ['Продолжай', 'Хватит, оставь как есть'],
          }
          break
        }
      }
      if (message.type === 'system' && message.subtype === 'init') {
        yield { kind: 'session', id: message.session_id }
        console.log(`[claude] просили ${input.model}, работает ${message.model}${input.resume ? ', сессия продолжена' : ''}`)
        continue
      }
      if (message.type === 'stream_event') {
        const event = message.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { kind: 'text', text: event.delta.text }
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          yield { kind: 'thinking', text: event.delta.thinking }
        }
        continue
      }
      if (message.type === 'result') {
        const used = ('usage' in message ? message.usage : null) as {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        } | null
        const cached = used?.cache_read_input_tokens ?? 0
        // Ошибка — до расхода: «usage» для вызывающего означает «ход окончен»,
        // а после ошибки ход может повториться заново (сессия не найдена).
        if (message.subtype !== 'success') {
          const errors = 'errors' in message ? (message.errors as string[] | undefined) : undefined
          const text = errors?.length ? errors.join('; ') : message.subtype
          if (message.subtype === 'error_max_turns') {
            yield { kind: 'text', text: `\n\n[достигнут потолок кругов: ${config.maxTurns}]` }
          } else if (!input.signal.aborted) {
            throw new Error(`Claude: ${text}`)
          }
        }
        yield {
          kind: 'usage',
          usage: {
            input: (used?.input_tokens ?? 0) + cached + (used?.cache_creation_input_tokens ?? 0),
            output: used?.output_tokens ?? 0,
            cached,
            cost: 'total_cost_usd' in message ? message.total_cost_usd : undefined,
          },
        }
      }
    }
  } finally {
    input.signal.removeEventListener('abort', onAbort)
  }
}
