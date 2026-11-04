/**
 * `electron-log/main` shim: file + console logger with the small surface the
 * desktop code base uses (levels, scopes, transports, error catching).
 */
import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly' | false

const LEVEL_WEIGHT: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
  silly: 5
}

const userDataDir = (): string => {
  try {
    // Avoid circular import: derive from env the same way the shim app does.
    const appData =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? `${process.env.HOME}/Library/Application Support`
        : process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`)
    return process.env.VIDBEE_USER_DATA_OVERRIDE || join(appData, 'vidbee')
  } catch {
    return process.cwd()
  }
}

const logFilePath = join(userDataDir(), 'logs', 'main.log')
try {
  mkdirSync(join(userDataDir(), 'logs'), { recursive: true })
} catch {
  // Fall back to console-only logging below.
}

const rotateIfNeeded = (): void => {
  const MAX_BYTES = 10 * 1024 * 1024
  try {
    if (existsSync(logFilePath) && statSync(logFilePath).size > MAX_BYTES) {
      unlinkSync(logFilePath)
    }
  } catch {
    // Rotation failures are non-fatal.
  }
}

class Logger {
  scopeInstance: string | null = null
  transports = {
    console: {
      level: 'silly' as LogLevel,
      format: false,
      writeFn: (line: string): void => {
        process.stdout.write(`${line}\n`)
      }
    },
    file: {
      level: 'silly' as LogLevel,
      maxSize: 10 * 1024 * 1024,
      getFile(): { path: string } {
        return { path: logFilePath }
      },
      writeFn: (line: string): void => {
        try {
          rotateIfNeeded()
          appendFileSync(logFilePath, `${line}\n`)
        } catch {
          // Disk failures must not crash the app.
        }
      }
    },
    ipc: {
      level: false as LogLevel
    }
  }
  errorHandler = {
    startCatching(
      options: {
        showDialog?: boolean
        onError?: (opts: { error: unknown; versions?: unknown }) => void
      } = {}
    ): void {
      process.on('uncaughtException', (error) => {
        options.onError?.({ error, versions: process.versions })
      })
      process.on('unhandledRejection', (reason) => {
        options.onError?.({ error: reason, versions: process.versions })
      })
    }
  }

  private writeLine(level: string, data: unknown[]): void {
    const fileLevel = this.transports.file.level
    const consoleLevel = this.transports.console.level
    const weight = LEVEL_WEIGHT[level] ?? 2
    if (fileLevel && weight <= (LEVEL_WEIGHT[fileLevel] ?? 2)) {
      this.transports.file.writeFn(this.formatLine(level, data))
    }
    if (consoleLevel && weight <= (LEVEL_WEIGHT[consoleLevel] ?? 2)) {
      this.transports.console.writeFn(this.formatLine(level, data))
    }
  }

  private formatLine(level: string, data: unknown[]): string {
    const timestamp = new Date().toISOString()
    const scope = this.scopeInstance ? `[${this.scopeInstance}] ` : ''
    const message = data
      .map((item) => (item instanceof Error ? (item.stack ?? item.message) : stringifyValue(item)))
      .join(' ')
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${scope}${message}`
  }

  scope(name: string): Logger {
    const scoped = new Logger()
    scoped.scopeInstance = name
    scoped.transports = this.transports
    scoped.errorHandler = this.errorHandler
    return scoped
  }

  error(...data: unknown[]): void {
    this.writeLine('error', data)
  }
  warn(...data: unknown[]): void {
    this.writeLine('warn', data)
  }
  info(...data: unknown[]): void {
    this.writeLine('info', data)
  }
  verbose(...data: unknown[]): void {
    this.writeLine('verbose', data)
  }
  debug(...data: unknown[]): void {
    this.writeLine('debug', data)
  }
  silly(...data: unknown[]): void {
    this.writeLine('silly', data)
  }
  log(...data: unknown[]): void {
    this.writeLine('info', data)
  }

  initialize(): void {
    // No-op: the file transport initializes lazily.
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const logger = new Logger()

export default logger
export const log = logger
