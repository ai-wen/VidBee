/**
 * Tauri adapter for the VidBee renderer.
 *
 * Under Tauri the Electron preload does not run. This module installs the same
 * `window.api` / `window.electron` surface the renderer expects, backed by the
 * sidecar core's HTTP bridge (requests) and SSE event stream (events).
 *
 * The Tauri shell injects `window.__VIDBEE_TAURI__` with connection settings
 * before any page script executes.
 */

import type { IpcServices } from '@shared/types/ipc'
import { createIpcProxy } from 'electron-ipc-decorator/client'

interface TauriBridgeConfig {
  port: number
  token: string
  platform: string
  versions: Record<string, string>
}

declare global {
  interface Window {
    __VIDBEE_TAURI__?: TauriBridgeConfig
  }
}

const config = window.__VIDBEE_TAURI__

export const isTauriRuntime = Boolean(config)

const baseUrl = config ? `http://127.0.0.1:${config.port}` : ''

type EventCallback = (...args: unknown[]) => void

const channelListeners = new Map<string, Set<EventCallback>>()

interface RendererEventMessage {
  channel: string
  args: unknown[]
}

function dispatchRendererEvent(message: RendererEventMessage): void {
  const listeners = channelListeners.get(message.channel)
  if (!listeners) {
    return
  }
  for (const listener of listeners) {
    listener(...message.args)
  }
}

function connectEventStream(): void {
  if (!config) {
    return
  }
  const connect = (): EventSource => {
    const source = new EventSource(`${baseUrl}/events`, {
      headers: { 'x-vidbee-token': config.token }
    })
    source.addEventListener('renderer', (event) => {
      try {
        const message = JSON.parse((event as MessageEvent<string>).data) as RendererEventMessage
        dispatchRendererEvent(message)
      } catch {
        // Malformed frame; ignore and keep the stream open.
      }
    })
    source.onerror = () => {
      source.close()
      window.setTimeout(() => {
        void connect()
      }, 1000)
    }
    return source
  }
  connect()
}

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, callback: (event: unknown, ...args: unknown[]) => void): EventCallback
  removeListener(channel: string, callback: EventCallback): void
}

const tauriIpcRenderer: IpcRendererLike = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!config) {
      throw new Error('Tauri bridge is not configured')
    }
    const response = await fetch(`${baseUrl}/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vidbee-token': config.token
      },
      body: JSON.stringify({ args })
    })
    if (!response.ok) {
      throw new Error(`IPC call failed with status ${response.status}`)
    }
    const result = (await response.json()) as
      | { ok: true; data: unknown }
      | { ok: false; error: { message?: string; name?: string } }
    if (!result.ok) {
      const error = new Error(result.error.message ?? `IPC call failed: ${channel}`)
      if (result.error.name) {
        error.name = result.error.name
      }
      throw error
    }
    return result.data
  },
  send(channel: string, ...args: unknown[]): void {
    if (!config) {
      return
    }
    void fetch(`${baseUrl}/send/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vidbee-token': config.token
      },
      body: JSON.stringify({ args })
    }).catch(() => {
      // Fire-and-forget mirrors Electron `send` semantics.
    })
  },
  on(channel: string, callback: (event: unknown, ...args: unknown[]) => void): EventCallback {
    const wrapped = (...args: unknown[]): void => {
      callback(undefined, ...args)
    }
    const listeners = channelListeners.get(channel) ?? new Set<EventCallback>()
    listeners.add(wrapped)
    channelListeners.set(channel, listeners)
    return wrapped
  },
  removeListener(channel: string, callback: EventCallback): void {
    channelListeners.get(channel)?.delete(callback)
  }
}

/**
 * Install `window.api` / `window.electron` before the React tree mounts.
 * Safe to call multiple times; under Electron this is a no-op.
 */
export function installTauriRendererBridge(): void {
  if (!config || window.__VIDBEE_TAURI_INSTALLED__) {
    return
  }
  window.__VIDBEE_TAURI_INSTALLED__ = true

  const ipcServices = createIpcProxy<IpcServices>(
    tauriIpcRenderer as unknown as Electron.IpcRenderer
  )

  const api = {
    ...ipcServices,
    on: (channel: string, callback: (...args: unknown[]) => void): EventCallback => {
      return tauriIpcRenderer.on(channel, callback)
    },
    removeListener: (channel: string, callback: EventCallback): void => {
      tauriIpcRenderer.removeListener(channel, callback)
    },
    send: (channel: string, ...args: unknown[]): void => {
      tauriIpcRenderer.send(channel, ...args)
    },
    getPathForFile: (_file: File): string | null => {
      // File-path resolution relies on Electron webUtils; drag-drop import
      // should switch to the native file dialog under Tauri.
      return null
    }
  }

  const electron = {
    ipcRenderer: tauriIpcRenderer,
    process: {
      platform: config.platform,
      arch: navigator.userAgent.includes('arm') ? 'arm64' : 'x64',
      versions: config.versions,
      env: {}
    },
    webFrame: {},
    nativeTheme: { shouldUseDarkColors: true }
  }

  Object.defineProperty(window, 'api', { value: api, configurable: true })
  Object.defineProperty(window, 'electron', { value: electron, configurable: true })

  connectEventStream()
}

declare global {
  interface Window {
    __VIDBEE_TAURI_INSTALLED__?: boolean
  }
}
