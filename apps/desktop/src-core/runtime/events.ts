/**
 * Renderer event bus + custom protocol registry for the Tauri sidecar core.
 *
 * `webContents.send` from the shimmed Electron API lands here and is fanned out
 * to the Tauri shell over the bridge's SSE endpoint. Custom protocol handlers
 * (`vidbee://`, `agent-artifact://`) are served to the webview by the same
 * bridge through the shell's URI-scheme proxy.
 */

export type RendererEventListener = (channel: string, args: unknown[]) => void

const listeners = new Set<RendererEventListener>()

export function emitToRenderer(channel: string, ...args: unknown[]): void {
  for (const listener of listeners) {
    try {
      listener(channel, args)
    } catch {
      // A failing SSE writer must not break other listeners.
    }
  }
}

export function subscribeRendererEvents(listener: RendererEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function rendererConnectionCount(): number {
  return listeners.size
}

// ─────────────────────────────────────────────────────────────
// Custom protocol registry
// ─────────────────────────────────────────────────────────────

export interface ProtocolRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: Buffer
}

export interface ProtocolResponse {
  path?: string
  status?: number
  headers?: Record<string, string>
  body?: Buffer
}

type ProtocolHandler = (request: ProtocolRequest) => Promise<ProtocolResponse>

const protocolHandlers = new Map<string, ProtocolHandler>()
const privilegedSchemes = new Set<string>()

export function registerSchemesAsPrivileged(schemes: string[]): void {
  for (const scheme of schemes) {
    privilegedSchemes.add(scheme)
  }
}

export function registerProtocol(scheme: string, handler: ProtocolHandler): void {
  protocolHandlers.set(scheme, handler)
}

export function getProtocolHandler(scheme: string): ProtocolHandler | undefined {
  return protocolHandlers.get(scheme)
}

export function isPrivilegedScheme(scheme: string): boolean {
  return privilegedSchemes.has(scheme)
}
