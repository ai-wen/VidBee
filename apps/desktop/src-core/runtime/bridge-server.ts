/**
 * HTTP bridge between the Tauri shell / webview and the sidecar core.
 *
 * Endpoints (loopback only, token-guarded):
 *   GET  /health                       → readiness probe
 *   POST /ipc/:channel                 → renderer `invoke` calls
 *   POST /send/:channel                → renderer `send` calls
 *   GET  /events                       → SSE stream of renderer-bound events
 *   POST /deeplink                     → vidbee:// deep link delivery
 *   GET  /protocol/:scheme/?url=...    → proxied custom-scheme requests
 *   GET  /file?path=...                → proxied vidbee-file requests
 *   POST /shutdown                     → graceful stop
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'

import { ipcMain } from '../shims/electron'
import { emitToRenderer, subscribeRendererEvents } from './events'
import { onShutdown } from './lifecycle'
import { handleProtocolRequest, handleVidbeeFileRequest } from './protocol-server'

const serverHost = '127.0.0.1'

let server: http.Server | null = null
let bridgePort: number | null = null
let bridgeToken = ''

interface CallBody {
  args?: unknown[]
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(payload)
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!bridgeToken) {
    return true
  }
  return req.headers['x-vidbee-token'] === bridgeToken
}

async function handleCall(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string
): Promise<void> {
  const raw = await readBody(req)
  let args: unknown[] = []
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as CallBody
    if (Array.isArray(parsed.args)) {
      args = parsed.args
    }
  } catch {
    writeJson(res, 400, { ok: false, error: { message: 'Invalid JSON body' } })
    return
  }

  try {
    const data = await ipcMain._invoke(channel, args)
    writeJson(res, 200, { ok: true, data })
  } catch (error) {
    writeJson(res, 200, {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined
      }
    })
  }
}

async function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string
): Promise<void> {
  const raw = await readBody(req)
  let args: unknown[] = []
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as CallBody
    if (Array.isArray(parsed.args)) {
      args = parsed.args
    }
  } catch {
    writeJson(res, 400, { ok: false, error: { message: 'Invalid JSON body' } })
    return
  }

  ipcMain._emit(channel, args)
  res.writeHead(204)
  res.end()
}

function handleEvents(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  })
  res.write('event: hello\ndata: connected\n\n')

  const unsubscribe = subscribeRendererEvents((channel, args) => {
    try {
      res.write(`event: renderer\ndata: ${JSON.stringify({ channel, args })}\n\n`)
    } catch {
      unsubscribe()
    }
  })

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      // Closed stream; cleanup happens in the close handler.
    }
  }, 15_000)

  res.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}

async function handleDeepLink(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as { url?: string }
    const url = parsed.url ?? ''
    const data = parseDownloadDeepLink(url)
    if (data) {
      emitToRenderer('download:deeplink', data)
      writeJson(res, 200, { ok: true, delivered: true })
      return
    }
    writeJson(res, 200, { ok: true, delivered: false })
  } catch {
    writeJson(res, 400, { ok: false, error: { message: 'Invalid JSON body' } })
  }
}

interface DeepLinkData {
  url: string
  type: 'single' | 'playlist'
}

const APP_PROTOCOL = 'vidbee'

/** Mirror of the Electron main window's deep-link parser. */
function parseDownloadDeepLink(rawUrl: string): DeepLinkData | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== `${APP_PROTOCOL}:`) {
      return null
    }
    const host = parsed.hostname
    const path = parsed.pathname.replace(/^\/+/, '')
    const isDownloadLink = host === 'download' || path.startsWith('download')
    if (!isDownloadLink) {
      return null
    }
    const targetUrl = parsed.searchParams.get('url')
    if (!targetUrl?.trim()) {
      return null
    }
    const typeParam = parsed.searchParams.get('type')
    const type = typeParam === 'playlist' ? 'playlist' : 'single'
    return { url: targetUrl.trim(), type }
  } catch {
    return null
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = new URL(req.url ?? '/', `http://${serverHost}`)

  if (!isAuthorized(req)) {
    writeJson(res, 401, { ok: false, error: { message: 'Unauthorized' } })
    return
  }

  if (parsed.pathname === '/health') {
    writeJson(res, 200, { ok: true, port: bridgePort })
    return
  }

  if (parsed.pathname === '/shutdown') {
    writeJson(res, 200, { ok: true })
    res.on('finish', () => {
      onShutdown()
    })
    return
  }

  if (parsed.pathname.startsWith('/ipc/')) {
    const channel = decodeURIComponent(parsed.pathname.slice('/ipc/'.length))
    await handleCall(req, res, channel)
    return
  }

  if (parsed.pathname.startsWith('/send/')) {
    const channel = decodeURIComponent(parsed.pathname.slice('/send/'.length))
    await handleSend(req, res, channel)
    return
  }

  if (parsed.pathname === '/events') {
    handleEvents(res)
    return
  }

  if (parsed.pathname === '/deeplink') {
    await handleDeepLink(req, res)
    return
  }

  if (parsed.pathname.startsWith('/protocol/')) {
    const scheme = decodeURIComponent(
      parsed.pathname.slice('/protocol/'.length).split('/')[0] ?? ''
    )
    const targetUrl = parsed.searchParams.get('url') ?? ''
    if (!(scheme && targetUrl)) {
      res.writeHead(400)
      res.end()
      return
    }
    await handleProtocolRequest(scheme, targetUrl, req, res)
    return
  }

  if (parsed.pathname === '/file') {
    handleVidbeeFileRequest(req, res)
    return
  }

  res.writeHead(404)
  res.end()
}

/** Start the bridge server; resolves once the port is bound. */
export function startBridgeServer(port: number, token: string): Promise<number> {
  bridgeToken = token
  return new Promise((resolvePromise, reject) => {
    server = http.createServer((req, res) => {
      route(req, res).catch(() => {
        try {
          res.writeHead(500)
          res.end()
        } catch {
          // Response already closed.
        }
      })
    })
    server.on('error', reject)
    server.listen(port, serverHost, () => {
      const address = server?.address()
      bridgePort = typeof address === 'object' && address ? address.port : port
      resolvePromise(bridgePort)
    })
  })
}

export function stopBridgeServer(): Promise<void> {
  return new Promise((resolvePromise) => {
    if (!server) {
      resolvePromise()
      return
    }
    server.close(() => {
      server = null
      resolvePromise()
    })
  })
}
