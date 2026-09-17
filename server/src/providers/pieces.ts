import type { Usage } from '../connection.ts'

/**
 * Общий язык провайдеров. Инструменты в этот поток не попадают: их
 * исполняет сам плагин и видит напрямую (tool_call по WebSocket). Здесь —
 * только то, что провайдер знает лучше плагина: текст, сессия, расход.
 */
export type Piece =
  | { kind: 'text'; text: string }
  /** Полная замена текущего текста — для провайдеров без дельт. */
  | { kind: 'text_replace'; text: string }
  | { kind: 'status'; text: string }
  /** Кусок размышления модели (сводка): показывается в ленте свёрнутой строкой. */
  | { kind: 'thinking'; text: string }
  /** Вопрос пользователю от gateway (ограничитель расхода): ход на этом кончается. */
  | { kind: 'ask'; question: string; options?: string[] }
  | { kind: 'session'; id: string }
  | { kind: 'usage'; usage: Usage }

export interface RunInput {
  /** Текст хода: сообщение пользователя вместе со снимком сцены. */
  prompt: string
  model: string
  /** Идентификатор сессии провайдера из прошлого хода, если есть. */
  resume?: string
  /** Картинки пользователя (оригиналы). */
  attachments?: Array<{ name: string; mime: string; base64: string }>
  /** Прервать ход. */
  signal: AbortSignal
}
