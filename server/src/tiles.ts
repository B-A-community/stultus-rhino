/**
 * «Большой кадр»: 4K-визуализация из плиток.
 *
 * Встроенный генератор Codex отдаёт около 1,6 мегапикселя и размер входа
 * игнорирует (проверено: вход 3840×2099 → выход 1695×928). Поэтому большой
 * кадр собирается так:
 *   1. эталон — обычная визуализация целого кадра;
 *   2. 4K-снимок из Rhino режется на сетку плиток с нахлёстом, каждая
 *      плитка уходит в генератор вместе с той же плиткой эталона как образцом;
 *   3. плитки сшиваются: на нахлёсте линейный переход, чтобы не было шва.
 *
 * Честное ограничение: генератор не гарантирует совпадение пикселей, на
 * прямых кромках у шва возможно двоение, тон плиток может немного отличаться.
 */
import sharp from 'sharp'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config } from './config.ts'
import { pngImage, postproductionPrompt, runNative, tilePrompt, type RenderImage } from './render.ts'

export interface Grid { cols: number; rows: number }
export interface Tile { col: number; row: number; left: number; top: number; width: number; height: number }
export interface Layout { tiles: Tile[]; overlapX: number; overlapY: number }

/**
 * Размеры большого кадра. Ширина — снимок из Rhino (высота по вьюпорту),
 * сетка подобрана так, чтобы плитка была около 1,6–2 мегапикселей: столько
 * отдаёт генератор, и растягивать результат почти не приходится.
 */
export const LARGE_SIZES = {
  '4k': { width: 3840, grid: '3x2', label: '4K' },
  '6k': { width: 5760, grid: '4x3', label: '6K' },
  '8k': { width: 7680, grid: '6x3', label: '8K' },
} as const
export type LargeSize = keyof typeof LARGE_SIZES
export const SIZE_IDS = ['normal', ...Object.keys(LARGE_SIZES)] as ['normal', ...LargeSize[]]

/** «large» из старых окон и промптов — это 4K. */
export function largeSize(size: string | undefined): LargeSize | null {
  if (size === 'large') return '4k'
  return size && size in LARGE_SIZES ? (size as LargeSize) : null
}

/** Ширина, в которую ужимается кадр для генератора: больше он всё равно не отдаёт. */
const GENERATOR_WIDTH = 1600
/** Ширина превью для чата и модели: 4K в ленту и в контекст модели не нужен. */
const PREVIEW_WIDTH = 1920
/**
 * Плитка без содержимого (пустой фон Rhino): разброс яркости ниже порога.
 * Такие плитки генератору не отдаём — он на пустом входе рисует плоские
 * серые прямоугольники; берём кусок эталона, там небо уже есть.
 */
const FLAT_STDEV = 6

export function parseGrid(text: string): Grid {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(text)
  const clamp = (v: number) => Math.min(8, Math.max(1, v))
  if (!m) return { cols: 3, rows: 2 }
  return { cols: clamp(Number(m[1])), rows: clamp(Number(m[2])) }
}

/**
 * Раскладка плиток. Нахлёст — доля от ширины (высоты) плитки; последняя
 * плитка прижата к краю, чтобы сетка покрывала кадр целиком.
 */
export function layoutTiles(width: number, height: number, grid: Grid, overlap: number): Layout {
  const axis = (size: number, count: number) => {
    if (count <= 1) return { step: [0], span: size, ov: 0 }
    const ov = Math.round(Math.min(0.4, Math.max(0, overlap)) * (size / count))
    const span = Math.ceil((size + (count - 1) * ov) / count)
    const step = Array.from({ length: count }, (_, i) => (i === count - 1 ? size - span : i * (span - ov)))
    return { step, span, ov }
  }
  const x = axis(width, grid.cols), y = axis(height, grid.rows)
  const tiles: Tile[] = []
  for (let row = 0; row < grid.rows; row++)
    for (let col = 0; col < grid.cols; col++)
      tiles.push({ col, row, left: x.step[col]!, top: y.step[row]!, width: x.span, height: y.span })
  return { tiles, overlapX: x.ov, overlapY: y.ov }
}

/**
 * Вес пикселя плитки по одной оси: у внутреннего края линейный подъём на
 * длине нахлёста, у края кадра — единица. Сумма весов соседей на нахлёсте
 * равна единице, значит переход ровный.
 */
export function axisWeights(offset: number, span: number, total: number, overlap: number): Float32Array {
  const w = new Float32Array(span).fill(1)
  if (overlap <= 0) return w
  const inner = (i: number) => (i + 1) / (overlap + 1)
  if (offset > 0) for (let i = 0; i < Math.min(overlap, span); i++) w[i] = inner(i)
  if (offset + span < total) for (let i = 0; i < Math.min(overlap, span); i++) w[span - 1 - i] = Math.min(w[span - 1 - i]!, inner(i))
  return w
}

/** Сшивает готовые плитки (PNG любого размера, растягиваются в свою ячейку) в один кадр. */
export async function stitch(width: number, height: number, layout: Layout, pieces: Array<{ tile: Tile; png: Buffer }>): Promise<Buffer> {
  const acc = new Float32Array(width * height * 3)
  const sum = new Float32Array(width * height)
  for (const { tile, png } of pieces) {
    const raw = await sharp(png).resize(tile.width, tile.height, { fit: 'fill' }).removeAlpha().raw().toBuffer()
    const wx = axisWeights(tile.left, tile.width, width, layout.overlapX)
    const wy = axisWeights(tile.top, tile.height, height, layout.overlapY)
    for (let y = 0; y < tile.height; y++) {
      const ty = tile.top + y
      if (ty < 0 || ty >= height) continue
      for (let x = 0; x < tile.width; x++) {
        const tx = tile.left + x
        if (tx < 0 || tx >= width) continue
        const w = wx[x]! * wy[y]!
        const src = (y * tile.width + x) * 3, dst = ty * width + tx
        acc[dst * 3] += raw[src]! * w
        acc[dst * 3 + 1] += raw[src + 1]! * w
        acc[dst * 3 + 2] += raw[src + 2]! * w
        sum[dst] += w
      }
    }
  }
  const out = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const s = sum[i]! || 1
    out[i * 3] = Math.round(acc[i * 3]! / s)
    out[i * 3 + 1] = Math.round(acc[i * 3 + 1]! / s)
    out[i * 3 + 2] = Math.round(acc[i * 3 + 2]! / s)
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer()
}

export function tilePosition(tile: Tile, grid: Grid): string {
  const h = grid.cols === 1 ? 'full width' : tile.col === 0 ? 'left' : tile.col === grid.cols - 1 ? 'right' : 'centre'
  const v = grid.rows === 1 ? 'full height' : tile.row === 0 ? 'top' : tile.row === grid.rows - 1 ? 'bottom' : 'middle'
  return `column ${tile.col + 1} of ${grid.cols}, row ${tile.row + 1} of ${grid.rows} (${v}, ${h})`
}

export type Generate = (sources: string | string[], directory: string, prompt: string, signal: AbortSignal) => Promise<RenderImage>

/** Полный кадр — файл целиком (в 8K это десятки мегабайт, в чат он не идёт), превью — для ленты и модели. */
export interface LargeResult { file: Buffer; width: number; height: number; preview: RenderImage; source: RenderImage; generations: number }

/** Сколько генераций займёт большой кадр: эталон плюс плитки. */
export function largeGenerations(size: LargeSize): number {
  const grid = parseGrid(LARGE_SIZES[size].grid)
  return 1 + grid.cols * grid.rows
}

/** Описание размеров для окна и для схемы инструмента. */
export function largeSizeList(): Array<{ id: LargeSize; label: string; width: number; generations: number }> {
  return (Object.keys(LARGE_SIZES) as LargeSize[]).map(id => ({ id, label: LARGE_SIZES[id].label, width: LARGE_SIZES[id].width, generations: largeGenerations(id) }))
}

export async function renderLarge(size: LargeSize, source: RenderImage, prompt: string, signal: AbortSignal,
  progress: (text: string) => void, generate: Generate = runNative): Promise<LargeResult> {
  const grid = parseGrid(LARGE_SIZES[size].grid)
  const total = AbortSignal.any([signal, AbortSignal.timeout(largeGenerations(size) * config.renderLargePerGenerationMs)])
  const perCall = () => AbortSignal.any([total, AbortSignal.timeout(config.renderTimeoutMs)])
  const root = resolve(config.workDir, 'renders')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, 'large-'))
  try {
    const full = Buffer.from(source.base64, 'base64')
    const { width, height } = source
    const layout = layoutTiles(width, height, grid, config.renderLargeOverlap)
    const n = layout.tiles.length

    progress(`Эталон целого кадра (1 из ${n + 1})…`)
    const basePath = join(directory, 'base.png')
    await writeFile(basePath, await sharp(full).resize({ width: Math.min(GENERATOR_WIDTH, width) }).png().toBuffer(), { mode: 0o600 })
    const base = await withRetry(() => generate(basePath, directory, postproductionPrompt(prompt), perCall()), total)
    const baseFull = await sharp(Buffer.from(base.base64, 'base64')).resize(width, height, { fit: 'fill' }).png().toBuffer()

    const pieces: Array<{ tile: Tile; png: Buffer }> = []
    let generations = 1
    for (const [i, tile] of layout.tiles.entries()) {
      total.throwIfAborted()
      const region = { left: tile.left, top: tile.top, width: tile.width, height: tile.height }
      const sourceTile = await sharp(full).extract(region).png().toBuffer()
      const referenceTile = await sharp(baseFull).extract(region).png().toBuffer()
      if (await isFlat(sourceTile)) {
        progress(`Плитка ${i + 1} из ${n}: пустой фон, беру из эталона`)
        pieces.push({ tile, png: referenceTile })
        continue
      }
      progress(`Плитка ${i + 1} из ${n} (${i + 2} из ${n + 1})…`)
      const src = join(directory, `tile-${i}-source.png`), ref = join(directory, `tile-${i}-reference.png`)
      await writeFile(src, sourceTile, { mode: 0o600 })
      await writeFile(ref, referenceTile, { mode: 0o600 })
      const piece = await withRetry(() => generate([src, ref], directory, tilePrompt(prompt, tilePosition(tile, grid)), perCall()), total)
      generations++
      pieces.push({ tile, png: Buffer.from(piece.base64, 'base64') })
    }

    progress('Сшиваю плитки…')
    const stitched = await stitch(width, height, layout, pieces)
    const preview = await sharp(stitched).resize({ width: Math.min(PREVIEW_WIDTH, width) }).png().toBuffer()
    const sourcePreview = await sharp(full).resize({ width: Math.min(PREVIEW_WIDTH, width) }).png().toBuffer()
    if (config.renderKeepLast) {
      const keep = join(root, 'last-large.png')
      await writeFile(keep, stitched, { mode: 0o600 }).catch(() => {})
      await copyFile(keep, keep).catch(() => {})
    }
    return {
      file: stitched, width, height,
      preview: pngImage(preview.toString('base64')),
      source: pngImage(sourcePreview.toString('base64')),
      generations,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Плитка практически одноцветная: пустой фон Rhino. */
export async function isFlat(png: Buffer): Promise<boolean> {
  const stats = await sharp(png).removeAlpha().stats()
  return Math.max(...stats.channels.map(c => c.stdev)) < FLAT_STDEV
}

/** Одна повторная попытка на плитку: лимиты и сетевые сбои генератора случаются. Остановка не повторяется. */
async function withRetry<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (signal.aborted) throw error
    return run()
  }
}
