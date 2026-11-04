/**
 * `electron-ga4-telemetry` stubs for the Tauri core.
 *
 * The GA4 transport relies on Electron preload plumbing that does not exist in
 * the Tauri shell, so telemetry installs as a disabled no-op transport.
 */

interface TransportInstallOptions {
  measurementId?: string
  origin?: string
  isAllowedSender?: (sender: unknown) => boolean
  [key: string]: unknown
}

export function installGoogleAnalytics(_options: TransportInstallOptions): {
  setEnabled(enabled: boolean): void
  isReady(): boolean
} {
  return {
    setEnabled(_enabled: boolean): void {},
    isReady(): boolean {
      return false
    }
  }
}

export default { installGoogleAnalytics }
