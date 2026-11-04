/**
 * Lifecycle helpers for the Tauri sidecar core (boot + graceful shutdown).
 */

const shutdownHooks: Array<() => Promise<void> | void> = []
let isShuttingDown = false

export function registerShutdownHook(hook: () => Promise<void> | void): void {
  shutdownHooks.push(hook)
}

export async function runShutdownHooks(): Promise<void> {
  if (isShuttingDown) {
    return
  }
  isShuttingDown = true
  for (const hook of shutdownHooks.reverse()) {
    try {
      await hook()
    } catch (error) {
      console.error('[vidbee-core] shutdown hook failed:', error)
    }
  }
}

export async function onShutdown(): Promise<void> {
  await runShutdownHooks()
  process.exit(0)
}

process.on('SIGINT', () => {
  void onShutdown()
})
process.on('SIGTERM', () => {
  void onShutdown()
})
