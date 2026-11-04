import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  emitToRenderer,
  type ProtocolRequest,
  type ProtocolResponse,
  registerProtocol,
  registerSchemesAsPrivileged
} from '../runtime/events'

// ─────────────────────────────────────────────────────────────
// Native bridge client (core -> Tauri shell)
// ─────────────────────────────────────────────────────────────

const NATIVE_PORT = process.env.VIDBEE_NATIVE_PORT || ''
const NATIVE_TOKEN = process.env.VIDBEE_NATIVE_TOKEN || ''

interface NativeResult<T = unknown> {
  ok: boolean
  data: T
}

/**
 * Forward a native GUI operation to the Tauri shell.
 * Returns `undefined` when the shell bridge is unavailable (headless dev runs).
 */
export async function callNative<T = unknown>(op: string, payload?: unknown): Promise<T> {
  if (!NATIVE_PORT) {
    throw new Error(`native bridge unavailable (op: ${op})`)
  }
  const response = await fetch(`http://127.0.0.1:${NATIVE_PORT}/native/${op}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vidbee-token': NATIVE_TOKEN
    },
    body: JSON.stringify(payload ?? {})
  })
  const result = (await response.json()) as NativeResult<T>
  if (!result.ok) {
    throw new Error(`native op failed: ${op}`)
  }
  return result.data
}

/**
 * Forward a native operation, falling back to a cancellation result when the
 * Tauri shell is not attached (e.g. running the core standalone for debugging).
 */
async function callNativeOrDefault<T>(op: string, fallback: T, payload?: unknown): Promise<T> {
  try {
    return await callNative<T>(op, payload)
  } catch {
    return fallback
  }
}

// ─────────────────────────────────────────────────────────────
// Paths / app metadata
// ─────────────────────────────────────────────────────────────

const APP_NAME = 'vidbee'

const appDataDir = (): string => {
  switch (process.platform) {
    case 'win32':
      return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support')
    default:
      return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  }
}

const defaultDownloadsDir = (): string => {
  if (process.platform === 'win32') {
    return join(homedir(), 'Downloads')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Downloads')
  }
  return join(homedir(), 'Downloads')
}

type AppPathName =
  | 'appData'
  | 'userData'
  | 'sessionData'
  | 'temp'
  | 'home'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'logs'
  | 'crashDumps'
  | 'exe'
  | 'module'

const pathOverrides = new Map<string, string>()

const defaultAppPaths = (): Record<string, string> => {
  const appData = appDataDir()
  const userData = join(appData, APP_NAME)
  return {
    appData,
    userData,
    sessionData: userData,
    temp: tmpdir(),
    home: homedir(),
    desktop: join(homedir(), 'Desktop'),
    documents: join(homedir(), 'Documents'),
    downloads: defaultDownloadsDir(),
    music: join(homedir(), 'Music'),
    pictures: join(homedir(), 'Pictures'),
    videos: join(homedir(), 'Videos'),
    logs: join(userData, 'logs'),
    crashDumps: join(userData, 'CrashDumps'),
    exe: process.execPath,
    module: import.meta.dirname
  }
}

const APP_VERSION: string =
  (globalThis as { __VIDBEE_VERSION__?: string }).__VIDBEE_VERSION__ ?? '0.0.0-dev'

// Served to the core as env so bundled binaries (ffmpeg/yt-dlp) resolve.
if (process.env.VIDBEE_RESOURCES_DIR) {
  ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath =
    process.env.VIDBEE_RESOURCES_DIR
}

class App extends EventEmitter {
  readonly name = APP_NAME
  readonly isPackaged = true
  readonly isReady = true
  locale = process.env.VIDBEE_LOCALE || 'en-US'
  readonly dock: undefined
  readonly commandLine = {
    appendSwitch: (_switch: string, _value?: string): void => {},
    appendArgument: (_value: string): void => {}
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  getVersion(): string {
    return APP_VERSION
  }

  getPath(name: AppPathName | string): string {
    const override = pathOverrides.get(name)
    if (override) {
      return override
    }
    const defaults = defaultAppPaths()
    const value = defaults[name]
    if (!value) {
      throw new Error(`Failed to get '${name}' path`)
    }
    return value
  }

  setPath(name: string, value: string): void {
    pathOverrides.set(name, value)
  }

  quit(): void {
    void callNativeOrDefault('app.quit', null).then(() => {
      // Fallback when the shell bridge is unavailable: exit after cleanup tick.
      setTimeout(() => process.exit(0), 500)
    })
  }

  exit(code = 0): void {
    process.exit(code)
  }

  relaunch(_options?: { args?: string[] }): void {}

  requestSingleInstanceLock(): boolean {
    return true
  }

  setAsDefaultProtocolClient(_protocol: string): boolean {
    return true
  }

  removeAsDefaultProtocolClient(_protocol: string): boolean {
    return true
  }

  isDefaultProtocolClient(_protocol: string): boolean {
    return false
  }

  setLoginItemSettings(_settings: Record<string, unknown>): void {}

  getLoginItemSettings(): { openAtLogin: boolean; wasOpenedAtLogin: boolean } {
    return { openAtLogin: false, wasOpenedAtLogin: false }
  }

  getLocale(): string {
    return this.locale
  }

  getLocaleCountryCode(): string {
    return ''
  }

  getSystemVersion(): string {
    return process.getSystemVersion?.() ?? ''
  }

  getAppPath(): string {
    return pathOverrides.get('module') ?? import.meta.dirname
  }

  setAppUserModelId(_id: string): void {}

  focus(_options?: { steal?: boolean }): void {}
}

export const app = new App()

// ─────────────────────────────────────────────────────────────
// Renderer-bound fake WebContents
// ─────────────────────────────────────────────────────────────

export class FakeWebContents {
  readonly isDestroyedValue = false

  send(channel: string, ...args: unknown[]): void {
    emitToRenderer(channel, ...args)
  }

  isDestroyed(): boolean {
    return false
  }

  getURL(): string {
    return 'https://tauri.localhost/'
  }

  getContentsId(): number {
    return 1
  }

  async setLoading(_loading: boolean): Promise<void> {}

  session = sessionShim
  on(): void {}
  once(): void {}
  removeListener(): void {}
  removeAllListeners(): void {}
}

const primaryWebContents = new FakeWebContents()

// ─────────────────────────────────────────────────────────────
// BrowserWindow (proxy to the single Tauri shell window)
// ─────────────────────────────────────────────────────────────

interface BrowserWindowConstructorOptions {
  width?: number
  height?: number
  show?: boolean
  frame?: boolean
  title?: string
  webPreferences?: Record<string, unknown>
  [key: string]: unknown
}

type NativeWindowOp =
  | 'minimize'
  | 'maximize'
  | 'unmaximize'
  | 'close'
  | 'hide'
  | 'show'
  | 'focus'
  | 'restore'
  | 'isMaximized'
  | 'isMinimized'
  | 'isVisible'

export class BrowserWindow {
  static readonly windows: BrowserWindow[] = []

  readonly webContents: FakeWebContents
  destroyed = false

  constructor(_options?: BrowserWindowConstructorOptions) {
    this.webContents = primaryWebContents
    BrowserWindow.windows.push(this)
  }

  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.windows
  }

  /** The Tauri shell has a single window; treat it as the focused one. */
  static getFocusedWindow(): BrowserWindow | null {
    return BrowserWindow.windows[0] ?? null
  }

  static fromId(_id: number): BrowserWindow | null {
    return BrowserWindow.windows[0] ?? null
  }

  private async native<T>(op: NativeWindowOp): Promise<T> {
    return callNativeOrDefault<T>(`window.${op}`, false as T)
  }

  minimize(): void {
    void this.native('minimize')
  }

  maximize(): void {
    void this.native('maximize')
  }

  unmaximize(): void {
    void this.native('unmaximize')
  }

  restore(): void {
    void this.native('restore')
  }

  close(): void {
    void this.native('close')
  }

  hide(): void {
    void this.native('hide')
  }

  show(): void {
    void this.native('show')
  }

  focus(): void {
    void this.native('focus')
  }

  async isMaximized(): Promise<boolean> {
    return this.native<boolean>('isMaximized')
  }

  async isMinimized(): Promise<boolean> {
    return this.native<boolean>('isMinimized')
  }

  async isVisible(): Promise<boolean> {
    return this.native<boolean>('isVisible')
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getNormalBounds(): { width: number; height: number; x?: number; y?: number } {
    return { width: 1200, height: 800 }
  }

  async loadURL(_url: string): Promise<void> {}

  setMenuBarVisibility(_visible: boolean): void {}
  setFullScreen(_flag: boolean): void {}
  isFullScreen(): boolean {
    return false
  }

  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this
  }

  once(_event: string, _listener: (...args: unknown[]) => void): this {
    return this
  }
}

// ─────────────────────────────────────────────────────────────
// ipcMain (wired to the Tauri bridge server)
// ─────────────────────────────────────────────────────────────

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
type IpcListener = (event: unknown, ...args: unknown[]) => void

const invokeHandlers = new Map<string, IpcHandler>()
const sendListeners = new Map<string, Set<IpcListener>>()

export interface FakeIpcEvent {
  sender: FakeWebContents
  process: { platform: NodeJS.Platform }
  frameId: number
  senderFrame: { url: string }
  replyChannel?: string
}

export const makeFakeEvent = (): FakeIpcEvent => ({
  sender: primaryWebContents,
  process: { platform: platform() as NodeJS.Platform },
  frameId: 1,
  senderFrame: { url: 'https://tauri.localhost/' }
})

export const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    invokeHandlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    invokeHandlers.delete(channel)
  },
  on(channel: string, listener: IpcListener): typeof ipcMain {
    const set = sendListeners.get(channel) ?? new Set<IpcListener>()
    set.add(listener)
    sendListeners.set(channel, set)
    return ipcMain
  },
  once(channel: string, listener: IpcListener): typeof ipcMain {
    const wrapped: IpcListener = (event, ...args) => {
      ipcMain.removeListener(channel, wrapped)
      listener(event, ...args)
    }
    return ipcMain.on(channel, wrapped)
  },
  removeListener(channel: string, listener: IpcListener): typeof ipcMain {
    sendListeners.get(channel)?.delete(listener)
    return ipcMain
  },
  removeAllListeners(channel: string): typeof ipcMain {
    sendListeners.delete(channel)
    return ipcMain
  },
  /** Used by the bridge server to dispatch renderer `invoke` calls. */
  async _invoke(channel: string, args: unknown[]): Promise<unknown> {
    const handler = invokeHandlers.get(channel)
    if (!handler) {
      throw new Error(`No handler registered for '${channel}'`)
    }
    return handler(makeFakeEvent(), ...args)
  },
  /** Used by the bridge server to dispatch renderer `send` calls. */
  _emit(channel: string, args: unknown[]): void {
    const set = sendListeners.get(channel)
    if (!set) {
      return
    }
    const event = makeFakeEvent()
    for (const listener of set) {
      listener(event, ...args)
    }
  },
  _hasInvokeHandler(channel: string): boolean {
    return invokeHandlers.has(channel)
  }
}

// ─────────────────────────────────────────────────────────────
// dialog / shell / clipboard / notification (forwarded to shell)
// ─────────────────────────────────────────────────────────────

interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  properties?: string[]
  filters?: { name: string; extensions: string[] }[]
}

interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: { name: string; extensions: string[] }[]
}

interface MessageBoxOptions {
  type?: string
  title?: string
  message: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  noLink?: boolean
}

export const dialog = {
  showOpenDialog(
    windowOrOptions?: BrowserWindow | OpenDialogOptions,
    maybeOptions?: OpenDialogOptions
  ): Promise<{ canceled: boolean; filePaths: string[]; filePath?: string }> {
    const options = (maybeOptions ?? windowOrOptions ?? {}) as OpenDialogOptions
    return callNativeOrDefault('dialog.showOpenDialog', { canceled: true, filePaths: [] }, options)
  },
  showSaveDialog(
    windowOrOptions?: BrowserWindow | SaveDialogOptions,
    maybeOptions?: SaveDialogOptions
  ): Promise<{ canceled: boolean; filePath?: string }> {
    const options = (maybeOptions ?? windowOrOptions ?? {}) as SaveDialogOptions
    return callNativeOrDefault('dialog.showSaveDialog', { canceled: true }, options)
  },
  showMessageBox(
    windowOrOptions?: BrowserWindow | MessageBoxOptions,
    maybeOptions?: MessageBoxOptions
  ): Promise<{ response: number; checkboxChecked: boolean }> {
    const options = (maybeOptions ?? windowOrOptions ?? {}) as MessageBoxOptions
    return callNativeOrDefault(
      'dialog.showMessageBox',
      { response: options.cancelId ?? 0, checkboxChecked: false },
      options
    )
  }
}

export const shell = {
  async openExternal(url: string, _options?: Record<string, unknown>): Promise<void> {
    await callNativeOrDefault('shell.openExternal', null, { url })
  },
  async openPath(path: string): Promise<string> {
    const result = await callNativeOrDefault('shell.openPath', { message: '' }, { path })
    return typeof result === 'string' ? result : ((result as { message?: string }).message ?? '')
  },
  showItemInFolder(path: string): void {
    void callNativeOrDefault('shell.showItemInFolder', null, { path })
  },
  async trashItem(path: string): Promise<void> {
    await callNativeOrDefault('shell.trashItem', null, { path })
  }
}

export const clipboard = {
  async writeText(text: string): Promise<void> {
    await callNativeOrDefault('clipboard.writeText', null, { text })
  },
  async readText(): Promise<string> {
    return callNativeOrDefault('clipboard.readText', '')
  },
  availableFormats(): string[] {
    return ['text/plain']
  },
  async writeImage(_image: NativeImage): Promise<void> {
    if (!_image.isEmpty()) {
      await callNativeOrDefault('clipboard.writeImage', null, {
        pngBase64: _image.toPNG().toString('base64')
      })
    }
  },
  /** Custom clipboard formats (file copy) are handled by native code; no-op here. */
  writeBuffer(_format: string, _buffer: Buffer): void {},
  read(_format: string): string {
    return ''
  },
  async write(_content: Record<string, unknown>): Promise<void> {
    if (typeof _content.text === 'string') {
      await clipboard.writeText(_content.text)
    }
  }
}

interface NotificationOptions {
  title?: string
  body?: string
  toastXml?: string
}

export class Notification {
  static isSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin'
  }

  private readonly emitter = new EventEmitter()
  private readonly options: NotificationOptions

  constructor(options: NotificationOptions) {
    this.options = options
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener)
    return this
  }

  show(): void {
    void callNativeOrDefault('notification.show', null, {
      title: this.options.title ?? '',
      body: this.options.body ?? ''
    })
      .then(() => this.emitter.emit('show'))
      .catch((error) => this.emitter.emit('failed', {}, error))
  }

  close(): void {}
}

// ─────────────────────────────────────────────────────────────
// nativeImage (minimal PNG/JPEG metadata support)
// ─────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function imageSizeFromBuffer(buffer: Buffer): { width: number; height: number } {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG: scan for SOF0/SOF2 markers.
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return { width: 0, height: 0 }
}

export class NativeImage {
  private readonly buffer: Buffer

  constructor(buffer: Buffer) {
    this.buffer = buffer
  }

  isEmpty(): boolean {
    return this.buffer.length === 0
  }

  getSize(): { width: number; height: number } {
    return imageSizeFromBuffer(this.buffer)
  }

  toPNG(): Buffer {
    return this.buffer
  }

  toJPEG(_quality?: number): Buffer {
    return this.buffer
  }

  toBitmap(): Buffer {
    return this.buffer
  }

  toDataURL(): string {
    return `data:image/png;base64,${this.buffer.toString('base64')}`
  }
}

export const nativeImage = {
  createFromPath(path: string): NativeImage {
    try {
      return new NativeImage(readFileSync(path))
    } catch {
      return new NativeImage(Buffer.alloc(0))
    }
  },
  createFromBuffer(buffer: Buffer): NativeImage {
    return new NativeImage(buffer)
  },
  createFromDataURL(dataUrl: string): NativeImage {
    const base64 = dataUrl.split(',')[1] ?? ''
    return new NativeImage(Buffer.from(base64, 'base64'))
  }
}

// ─────────────────────────────────────────────────────────────
// safeStorage (base64 obfuscation fallback)
// ─────────────────────────────────────────────────────────────

const SAFE_STORAGE_PREFIX = 'vb1:'

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return true
  },
  encryptString(plainText: string | Buffer): Buffer {
    const raw = Buffer.isBuffer(plainText) ? plainText : Buffer.from(plainText, 'utf8')
    return Buffer.from(SAFE_STORAGE_PREFIX + raw.toString('base64'), 'utf8')
  },
  decryptString(encrypted: Buffer): string {
    const text = encrypted.toString('utf8')
    if (text.startsWith(SAFE_STORAGE_PREFIX)) {
      return Buffer.from(text.slice(SAFE_STORAGE_PREFIX.length), 'base64').toString('utf8')
    }
    // Legacy Electron-encrypted payloads cannot be recovered; surface empty.
    throw new Error('Unable to decrypt secret (stored by a different backend)')
  },
  getSelectedStorageBackend(): string {
    return 'basic_text'
  }
}

// ─────────────────────────────────────────────────────────────
// ShareMenu / Menu / Tray / misc GUI stubs
// ─────────────────────────────────────────────────────────────

export class ShareMenu {
  popup(_options?: Record<string, unknown>): void {}
}

type MenuItemConstructorOptions = Record<string, unknown>

export const Menu = {
  buildFromTemplate(_template: MenuItemConstructorOptions[]): unknown {
    return null
  },
  setApplicationMenu(_menu: unknown): void {},
  getApplicationMenu(): null {
    return null
  }
}

export class Tray {
  setImage(_image: NativeImage | string): void {}
  setToolTip(_tip: string): void {}
  setTitle(_title: string): void {}
  setContextMenu(_menu: unknown): void {}
  displayBalloon(_options: Record<string, unknown>): void {}
  on(): this {
    return this
  }
  once(): this {
    return this
  }
  destroy(): void {}
}

export const powerSaveBlocker = (() => {
  let nextId = 1
  const started = new Set<number>()
  return {
    started,
    start(_type: string): number {
      const id = nextId++
      started.add(id)
      return id
    },
    stop(id: number): boolean {
      return started.delete(id)
    },
    isStarted(id: number): boolean {
      return started.has(id)
    }
  }
})()

export const nativeTheme = {
  shouldUseDarkColors: true,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  themeSource: 'system' as 'system' | 'dark' | 'light',
  on(): void {}
}

export const net = {
  async fetch(input: string | URL | Request, _init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('file://')) {
      const filePath = fileURLToPath(url)
      if (!existsSync(filePath)) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(readFileSync(filePath))
    }
    return fetch(input, _init)
  }
}

// ─────────────────────────────────────────────────────────────
// protocol (handlers are served to the webview through the core HTTP bridge)
// ─────────────────────────────────────────────────────────────

export const protocol = {
  registerSchemesAsPrivileged(schemes: { scheme: string; privileges?: unknown }[]): void {
    registerSchemesAsPrivileged(schemes.map((item) => item.scheme))
  },
  registerFileProtocol(
    scheme: string,
    handler: (
      request: ProtocolRequest,
      callback: (response: string | ProtocolResponse) => void
    ) => void
  ): boolean {
    registerProtocol(scheme, async (request) => {
      return await new Promise<ProtocolResponse>((resolvePromise) => {
        handler(request, (response) => {
          if (typeof response === 'string') {
            resolvePromise({ path: response })
            return
          }
          resolvePromise(response)
        })
      })
    })
    return true
  },
  handle(
    scheme: string,
    handler: (request: ProtocolRequest) => Promise<Response> | Response
  ): boolean {
    registerProtocol(scheme, async (request) => {
      const response = await handler(request)
      const buffer = Buffer.from(await response.arrayBuffer())
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: buffer
      }
    })
    return true
  },
  unregisterProtocol(_scheme: string): boolean {
    return true
  },
  isProtocolHandled(_scheme: string): boolean {
    return true
  }
}

// ─────────────────────────────────────────────────────────────
// session / webUtils stubs
// ─────────────────────────────────────────────────────────────

export const sessionShim = {
  defaultSession: {
    webRequest: {
      onHeadersReceived: (_listener?: unknown): void => {},
      onBeforeRequest: (_listener?: unknown): void => {},
      onBeforeSendHeaders: (_listener?: unknown): void => {}
    },
    protocol,
    setPermissionRequestHandler: (_handler?: unknown): void => {},
    clearCache: async (): Promise<void> => {},
    clearStorageData: async (): Promise<void> => {}
  }
}

export const session = sessionShim

export const webUtils = {
  getPathForFile(_file: unknown): string {
    return ''
  }
}

export const screen = {
  getPrimaryDisplay(): { workAreaSize: { width: number; height: number } } {
    return { workAreaSize: { width: 1920, height: 1080 } }
  },
  getAllDisplays(): unknown[] {
    return []
  },
  on(): void {}
}

export const globalShortcut = {
  register(): boolean {
    return false
  },
  unregister(): void {},
  unregisterAll(): void {}
}

// Re-export the core bridge helpers so boot code can resolve paths uniformly.
export { join, resolve, writeFileSync }
