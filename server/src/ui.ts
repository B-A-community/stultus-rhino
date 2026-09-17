/**
 * Окно плагина живёт на gateway: /ui/ отдаёт index.html, app.js, стили и
 * tools.js — Python-скрипты инструментов, собранные из rhino/*.py. Хост в
 * Rhino лишь показывает эту страницу в WebView2 и исполняет присланный
 * Python, поэтому обновление сервера = обновление окна и инструментов у
 * всех сотрудников сразу.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { config } from './config.ts'
import { HOST_MIN_VERSION, VERSION } from './version.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.yak': 'application/zip',
  '.py': 'text/x-python; charset=utf-8',
}

/** Python-скрипты инструментов: имя файла без расширения → исходник. */
export function loadTools(): Record<string, string> {
  const tools: Record<string, string> = {}
  if (!existsSync(config.rhinoDir)) return tools
  // _common.py — общие импорты и помощники, приклеиваются в начало каждого скрипта.
  const commonPath = join(config.rhinoDir, '_common.py')
  const common = existsSync(commonPath) ? readFileSync(commonPath, 'utf8') : ''
  for (const file of readdirSync(config.rhinoDir).sort()) {
    if (extname(file) !== '.py' || file.startsWith('_')) continue
    tools[basename(file, '.py')] = `${common}\n# ---- ${file} ----\n${readFileSync(join(config.rhinoDir, file), 'utf8')}`
  }
  return tools
}

/**
 * tools.js собирается на каждый запрос: при разработке правка .py видна по
 * перезагрузке окна, а в бою запросов один на открытие окна.
 */
export function toolsScript(): string {
  const tools = loadTools()
  return `/* Stultus Rhino ${VERSION}: Python-скрипты инструментов, исполняются хостом в Rhino. */\n` +
    `window.StultusTools = ${JSON.stringify({ version: VERSION, host_min: HOST_MIN_VERSION, tools }, null, 0)};\n`
}

function safeJoin(root: string, rel: string): string | null {
  const full = normalize(join(root, rel))
  const base = resolve(root) + sep
  return full.startsWith(base) || full === resolve(root) ? full : null
}

function sendFile(res: ServerResponse, file: string, cacheable: boolean): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    // Окно грузится редко, а обновления должны доходить сразу: без кэша.
    'cache-control': cacheable ? 'public, max-age=3600' : 'no-store',
    'access-control-allow-origin': '*',
  })
  createReadStream(file).pipe(res)
  return true
}

/** GET /ui/…, /download/… . Возвращает false, если путь не наш. */
export function handleStatic(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const path = url.pathname

  if (path === '/ui' || path === '/ui/') {
    res.writeHead(302, { location: '/ui/index.html' })
    res.end()
    return true
  }
  if (path === '/ui/tools.js') {
    const body = toolsScript()
    res.writeHead(200, { 'content-type': TYPES['.js']!, 'cache-control': 'no-store' })
    res.end(body)
    return true
  }
  if (path.startsWith('/ui/')) {
    const file = safeJoin(config.uiDir, decodeURIComponent(path.slice('/ui/'.length)))
    if (!file || !sendFile(res, file, false)) {
      res.writeHead(404)
      res.end()
    }
    return true
  }
  if (path.startsWith('/download/')) {
    const name = decodeURIComponent(path.slice('/download/'.length))
    const file = safeJoin(config.packagesDir, name)
    if (!file || !sendFile(res, file, true)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Пакета нет на gateway.')
    }
    return true
  }
  return false
}

/** Самый свежий .yak в каталоге пакетов — для ссылки «обновить плагин». */
export function latestPackage(): { name: string; version: string } | null {
  if (!existsSync(config.packagesDir)) return null
  const files = readdirSync(config.packagesDir).filter((f) => f.endsWith('.yak'))
  let best: { name: string; version: string } | null = null
  for (const f of files) {
    const m = /-(\d+\.\d+\.\d+)(?:-[a-z0-9]+)?-/i.exec(f) ?? /-(\d+\.\d+\.\d+)/.exec(f)
    const version = m?.[1] ?? '0.0.0'
    if (!best || versionLessLocal(best.version, version)) best = { name: f, version }
  }
  return best
}

function versionLessLocal(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  return false
}
