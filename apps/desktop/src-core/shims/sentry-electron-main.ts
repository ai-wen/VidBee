/**
 * `@sentry/electron/main` shim: telemetry is disabled in the Tauri core until
 * `@sentry/node` is wired up. All exported helpers are no-ops.
 */
type Level = 'debug' | 'error' | 'fatal' | 'info' | 'log' | 'warning'

const noop = (): void => {}

export function init(_options?: unknown): void {}
export function captureException(_exception: unknown, _hint?: unknown): string {
  return ''
}
export function captureMessage(_message: string, _level?: Level): string {
  return ''
}
export function addBreadcrumb(_breadcrumb: unknown): void {}
export function withScope(_callback: (scope: unknown) => void): void {
  _callback({
    setTag: noop,
    setContext: noop,
    setFingerprint: noop,
    setLevel: noop,
    addBreadcrumb: noop
  })
}
export function setUser(_user: unknown): void {}
export function setTag(_key: string, _value: string): void {}
export function setContext(_name: string, _context: unknown): void {}
export function setExtra(_key: string, _extra: unknown): void {}
export function flush(_timeout?: number): Promise<boolean> {
  return Promise.resolve(true)
}
export function close(_timeout?: number): Promise<boolean> {
  return Promise.resolve(true)
}

const Sentry = {
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  withScope,
  setUser,
  setTag,
  setContext,
  setExtra,
  flush,
  close
}
export default Sentry
