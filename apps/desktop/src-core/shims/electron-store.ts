/**
 * `electron-store` shim: JSON-file-backed key/value store with the surface the
 * desktop code uses (`get`, `set`, `delete`, `clear`, `store`, `onDidChange`).
 * The file layout matches `conf` (pretty-printed JSON) so existing user
 * settings written by the Electron build keep working.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface StoreOptions<T extends Record<string, unknown>> {
  cwd?: string
  name?: string
  defaults?: T
}

export class Store<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly filePath: string
  private readonly data: Record<string, unknown>

  constructor(options: StoreOptions<T> = {}) {
    const name = options.name ?? 'config'
    const directory = options.cwd ?? '.'
    this.filePath = join(directory, `${name}.json`)
    this.data = {}

    let persisted: Record<string, unknown> = {}
    try {
      if (existsSync(this.filePath)) {
        const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          persisted = parsed as Record<string, unknown>
        }
      }
    } catch {
      persisted = {}
    }

    this.data = { ...persisted }
    if (options.defaults) {
      for (const [key, value] of Object.entries(options.defaults)) {
        if (!(key in this.data)) {
          this.data[key] = value
        }
      }
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      this.flush()
    } catch {
      // Unwritable store degrades to in-memory only.
    }
  }

  get<Key extends keyof T>(key: Key): T[Key] | undefined {
    return this.data[key as string] as T[Key] | undefined
  }

  set<Key extends keyof T>(keyOrValues: Key | Partial<T>, value?: T[Key]): void {
    if (
      typeof keyOrValues === 'string' ||
      typeof keyOrValues === 'number' ||
      typeof keyOrValues === 'symbol'
    ) {
      this.data[keyOrValues as string] = value
    } else {
      for (const [key, entry] of Object.entries(keyOrValues as Record<string, unknown>)) {
        this.data[key] = entry
      }
    }
    this.flush()
  }

  has(key: string): boolean {
    return key in this.data
  }

  delete(key: string): void {
    delete this.data[key]
    this.flush()
  }

  clear(): void {
    for (const key of Object.keys(this.data)) {
      delete this.data[key]
    }
    this.flush()
  }

  get store(): T {
    return this.data as T
  }

  set store(values: T) {
    for (const key of Object.keys(this.data)) {
      delete this.data[key]
    }
    for (const [key, value] of Object.entries(values)) {
      this.data[key] = value
    }
    this.flush()
  }

  onDidChange<Key extends keyof T>(
    key: Key,
    callback: (newValue: T[Key] | undefined, oldValue: T[Key] | undefined) => void
  ): () => void {
    let previous = this.get(key)
    const timer = setInterval(() => {
      const current = this.get(key)
      if (current !== previous) {
        const oldValue = previous
        previous = current
        callback(current, oldValue)
      }
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.filePath, `${JSON.stringify(this.data, null, '\t')}\n`)
    } catch {
      // Ignore write failures; state stays in memory.
    }
  }
}

// biome-ignore lint/complexity/noRedundantDefaultExport: consumers read `ElectronStore.default || ElectronStore` for CJS interop, so the default export must stay
export default Store
