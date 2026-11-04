/**
 * Custom protocol + local file serving for the Tauri shell.
 *
 * The Tauri shell registers `vidbee://`, `vidbee-file://`, and
 * `agent-artifact://` URI schemes in the webview and proxies every request to
 * this server, which mirrors the Electron protocol handlers:
 *   - `vidbee://<userData-relative-path>` → files under the userData directory
 *   - `vidbee-file:///<absolute-path>`    → any local file (media playback)
 *   - other schemes                       → handlers registered by main code
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'

import { app } from '../shims/electron'
import { getProtocolHandler } from './events'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

const contentTypeFor = (filePath: string): string =>
  MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

function sanitizeRequestPath(rawUrl: URL): string {
  const rawPath = `${rawUrl.hostname}${decodeURIComponent(rawUrl.pathname)}`
  const trimmedLeading = rawPath.replace(/^\/+/, '')
  const cleaned = trimmedLeading.replace(/\/+$/, '')
  return cleaned || 'index.html'
}

function isWithinBase(targetPath: string, basePath: string): boolean {
  const relativePath = relative(basePath, targetPath)
  return !(relativePath.startsWith('..') || isAbsolute(relativePath))
}

function resolveVidbeeFilePath(requestUrl: URL): string | null {
  const userDataPath = app.getPath('userData')
  const sanitizedPath = sanitizeRequestPath(requestUrl)
  const userDataTarget = resolve(userDataPath, sanitizedPath)

  if (isWithinBase(userDataTarget, userDataPath) && existsSync(userDataTarget)) {
    return userDataTarget
  }

  return null
}

interface RangeSpec {
  start: number
  end: number
  partial: boolean
}

function parseRange(header: string | undefined, size: number): RangeSpec | null {
  if (!header || size <= 0) {
    return null
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) {
    return null
  }
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') {
    return null
  }
  let start: number
  let end: number
  if (startRaw === '') {
    const suffixLength = Number.parseInt(endRaw, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null
    }
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number.parseInt(startRaw, 10)
    end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10)
  }
  if (!(Number.isFinite(start) && Number.isFinite(end)) || start > end || start >= size) {
    return null
  }
  return { start, end: Math.min(end, size - 1), partial: true }
}

function sendFileResponse(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    res.writeHead(404)
    res.end()
    return
  }

  const range = parseRange(req.headers.range, size)
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentTypeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  }

  if (range) {
    baseHeaders['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
    baseHeaders['Content-Length'] = String(range.end - range.start + 1)
    res.writeHead(range.partial ? 206 : 200, baseHeaders)
    const stream = createReadStream(filePath, { start: range.start, end: range.end })
    stream.pipe(res)
    stream.on('error', () => res.destroy())
    return
  }

  baseHeaders['Content-Length'] = String(size)
  res.writeHead(200, baseHeaders)
  const stream = createReadStream(filePath)
  stream.pipe(res)
  stream.on('error', () => res.destroy())
}

/** Handle a `vidbee-file:///<absolute-path>` proxied request. */
export function handleVidbeeFileRequest(req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? '/'
  const parsed = new URL(rawUrl, 'http://localhost')
  const target = parsed.searchParams.get('path') ?? ''
  const decoded = decodeURIComponent(target)

  if (!(decoded && isAbsolute(decoded) && existsSync(decoded))) {
    res.writeHead(404)
    res.end()
    return
  }

  sendFileResponse(req, res, decoded)
}

/** Handle a proxied custom-scheme request (`vidbee://`, `agent-artifact://`, ...). */
export async function handleProtocolRequest(
  scheme: string,
  fullUrl: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const handler = getProtocolHandler(scheme)
  if (!handler) {
    res.writeHead(404)
    res.end()
    return
  }

  try {
    const requestUrl = new URL(fullUrl)

    // `vidbee://` mirrors the Electron protocol: serve userData files.
    if (scheme === 'vidbee') {
      const filePath = resolveVidbeeFilePath(requestUrl)
      if (!filePath) {
        res.writeHead(404)
        res.end()
        return
      }
      sendFileResponse(req, res, filePath)
      return
    }

    const response = await handler({
      url: fullUrl,
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>
    })

    if (response.path) {
      sendFileResponse(req, res, response.path)
      return
    }

    const body = response.body ?? Buffer.alloc(0)
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      ...(response.headers ?? {})
    }
    headers['Content-Length'] = String(body.length)
    res.writeHead(response.status ?? 200, headers)
    res.end(body)
  } catch {
    res.writeHead(500)
    res.end()
  }
}
