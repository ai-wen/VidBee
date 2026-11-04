/**
 * `@better-auth/electron` stubs for the Tauri core.
 *
 * The desktop OAuth flow (custom protocol callback + auth window) is an
 * Electron-only surface. The stub keeps `createAuthClient` construction alive
 * so the account service imports cleanly; sign-in actions degrade to errors
 * until the Tauri shell implements a browser-based flow.
 */

export function electronClient(_options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'electron',
    getActions: () => ({}),
    getter: () => ({}),
    $Infer: {}
  }
}

export interface StorageOptions {
  projectName?: string
  [key: string]: unknown
}

export function storage(options: StorageOptions = {}): {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
} {
  const prefix = options.projectName ? `${options.projectName}:` : ''
  const memory = new Map<string, string>()
  return {
    async get(key: string): Promise<string | null> {
      return memory.get(`${prefix}${key}`) ?? null
    },
    async set(key: string, value: string): Promise<void> {
      memory.set(`${prefix}${key}`, value)
    },
    async remove(key: string): Promise<void> {
      memory.delete(`${prefix}${key}`)
    }
  }
}
