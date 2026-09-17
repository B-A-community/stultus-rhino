import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { providerList, runChat } from './chat.ts'
import { config } from './config.ts'
import { PluginConnection, type PluginMessage } from './connection.ts'
import { handleMcp } from './mcp.ts'
import { deleteRecipe, listRecipes } from './recipes.ts'
import { renderConfigured } from './render.ts'
import { handleStatic, latestPackage } from './ui.ts'
import { HOST_MIN_VERSION, VERSION, versionLess } from './version.ts'

/** Живые окна Rhino по id соединения. */
const connections = new Map<string, PluginConnection>()

mkdirSync(config.workDir, { recursive: true })
mkdirSync(config.packagesDir, { recursive: true })

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        name: 'stultus-rhino-gateway',
        version: VERSION,
        host_min: HOST_MIN_VERSION,
        package: latestPackage(),
        image_generation: { provider: 'codex', configured: renderConfigured() },
        windows: [...connections.values()].map((c) => ({
          id: c.id,
          model: c.instance.model_title,
          host: c.instance.plugin,
          busy: Boolean(c.running),
        })),
        providers: providerList().map((p) => ({ id: p.id, configured: p.configured })),
      }),
    )
    return
  }

  if (handleStatic(req, res, url)) return

  const mcp = url.pathname.match(/^\/mcp\/([0-9a-f-]{36})$/)
  if (mcp) {
    const conn = connections.get(mcp[1]!)
    if (!conn) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no such window' }))
      return
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined
      await handleMcp(conn, req, res, body)
    } catch (error) {
      console.error('[mcp]', error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
    return
  }

  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http, path: '/ws' })

wss.on('connection', (ws) => {
  const conn = new PluginConnection(ws)
  connections.set(conn.id, conn)
  console.log(`[ws] подключение ${conn.id.slice(0, 8)} (всего ${connections.size})`)

  ws.on('message', (data) => {
    let msg: PluginMessage
    try {
      msg = JSON.parse(data.toString()) as PluginMessage
    } catch {
      return
    }
    if (msg.type === 'hello') {
      if (!config.pluginToken || msg.token !== config.pluginToken) {
        conn.close(4401, 'bad token')
        return
      }
      conn.authed = true
      conn.instance = msg.instance ?? {}
      conn.sessions = { ...(msg.sessions ?? {}) }
      const host = conn.instance.plugin ?? '0.0.0'
      console.log(`[ws] ${conn.id.slice(0, 8)}: ${conn.instance.model_title ?? '?'} · Rhino ${conn.instance.app_version ?? '?'} · хост ${host}`)
      conn.send({
        type: 'welcome',
        version: VERSION,
        providers: providerList(),
        host_min: HOST_MIN_VERSION,
        host_outdated: versionLess(host, HOST_MIN_VERSION),
        package: latestPackage(),
      })
      conn.send({ type: 'recipes', recipes: listRecipes() })
      return
    }
    if (!conn.authed) {
      conn.close(4401, 'hello first')
      return
    }
    switch (msg.type) {
      case 'chat':
        void runChat(conn, msg)
        break
      case 'tool_result':
        conn.resolveTool(msg.call_id, { ok: msg.ok, content: msg.content ?? '', image: msg.image, capture: msg.capture, prompt: msg.prompt, size: msg.size })
        break
      case 'cancel':
        conn.running?.cancel()
        break
      case 'recipe_delete':
        deleteRecipe(msg.id)
        // Копилка общая: обновить у всех подключённых окон.
        for (const c of connections.values()) c.send({ type: 'recipes', recipes: listRecipes() })
        break
    }
  })

  ws.on('close', () => {
    conn.dispose()
    connections.delete(conn.id)
    console.log(`[ws] отключение ${conn.id.slice(0, 8)} (всего ${connections.size})`)
  })
})

http.listen(config.port, config.host, () => {
  const p = providerList()
  console.log(`stultus-rhino-gateway ${VERSION} на :${config.port}; окно /ui/, MCP для моделей ${config.mcpBase}/mcp/<id>`)
  console.log(`провайдеры: ${p.map((x) => `${x.label}${x.configured ? '' : ' (не настроен)'}`).join(', ')}`)
  if (!config.pluginToken) console.warn('PLUGIN_TOKEN не задан — плагины не будут приняты')
})
