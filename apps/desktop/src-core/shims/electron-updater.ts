/**
 * `electron-updater` shim: auto-update flows are handled by the Tauri shell
 * packaging step later; the stub keeps the update service code paths alive and
 * reports "no update available" so the UI stays functional.
 */
import { EventEmitter } from 'node:events'

class AutoUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  allowDowngrade = false
  channel = 'latest'
  logger: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void } | null =
    null
  currentVersion = '0.0.0'

  async checkForUpdates(): Promise<{ isUpdateAvailable: boolean } | null> {
    this.logger?.info?.('[tauri-core] auto-update check skipped (stub)')
    return { isUpdateAvailable: false }
  }

  async checkForUpdatesAndNotify(): Promise<unknown> {
    return this.checkForUpdates()
  }

  async downloadUpdate(): Promise<void> {}

  async quitAndInstall(): Promise<void> {}

  setFeedURL(_options: unknown): void {}
}

export const autoUpdater = new AutoUpdater()
