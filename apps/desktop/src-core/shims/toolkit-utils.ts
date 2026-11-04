/**
 * `@electron-toolkit/utils` shim: Electron runtime helpers are irrelevant in
 * the Tauri core, but keep the exports so shared code paths stay importable.
 */
export const electronApp = {
  setAppUserModelId(_id: string): void {},
  setIsDefaultApplicationForCurrentUser(): boolean {
    return false
  },
  setAsDefaultClientForProtocol(_protocol: string): boolean {
    return false
  },
  setLoginItemSettings(_settings: unknown): void {},
  getPath(_name: string): string {
    return ''
  }
}

export const optimizer = {
  watchWindowShortcuts(_window: unknown, _options?: unknown): void {}
}

export const isDev = process.env.NODE_ENV !== 'production'
export const is = {
  dev: isDev,
  windows: process.platform === 'win32',
  macOS: process.platform === 'darwin',
  linux: process.platform === 'linux',
  get platform(): NodeJS.Platform {
    return process.platform
  }
}
