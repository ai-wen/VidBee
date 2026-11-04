/**
 * VidBee Tauri sidecar core entry.
 *
 * Runs the existing Electron main-process service layer inside a plain Node
 * process. The Electron API is replaced at bundle time by the shim in
 * `shims/electron.ts`, and the Tauri shell talks to this process through
 * `runtime/bridge-server.ts`.
 */
import { configureLogger } from '../src/main/config/logger-config'
import { services } from '../src/main/ipc'

// Side-effect imports: the shim's `app` shim must be registered before any
// main-process module reads paths, and importing `../main/ipc` constructs all
// IPC services (registering their channels into the shimmed `ipcMain`).
import { registerAgentArtifactProtocol } from '../src/main/lib/agent-artifacts'
import { downloadEngine } from '../src/main/lib/download-facade'
import { ffmpegManager } from '../src/main/lib/ffmpeg-manager'
import { stopPlayerHost } from '../src/main/lib/player-host'
import { initializeOptionalTool } from '../src/main/lib/startup-dependencies'
import {
  listDesktopSubscriptionsSnapshot,
  startDesktopSubscriptions,
  stopDesktopSubscriptions
} from '../src/main/lib/subscriptions-host'
import { startDesktopTaskQueue, stopDesktopTaskQueue } from '../src/main/lib/task-queue-host'
import { runDesktopTaskQueueMigration } from '../src/main/lib/task-queue-migrate'
import {
  startAutoTranscription,
  startIdleMinimalModelFill,
  subscribeTranscriptBroadcasts
} from '../src/main/lib/transcript-host'
import {
  initializeYtDlpKernelService,
  stopYtDlpKernelService
} from '../src/main/lib/ytdlp-kernel-host'
import { startExtensionApiServer, stopExtensionApiServer } from '../src/main/local-api'
import { settingsManager } from '../src/main/settings'
import { scopedLoggers } from '../src/main/utils/logger'
import { startBridgeServer } from './runtime/bridge-server'
import { emitToRenderer } from './runtime/events'
import { registerShutdownHook, runShutdownHooks } from './runtime/lifecycle'
import { ipcMain } from './shims/electron'

const CORE_PORT = Number.parseInt(process.env.VIDBEE_CORE_PORT ?? '', 10)
const CORE_TOKEN = process.env.VIDBEE_CORE_TOKEN ?? ''

if (!Number.isFinite(CORE_PORT)) {
  console.error('[vidbee-core] VIDBEE_CORE_PORT is required')
  process.exit(1)
}

async function boot(): Promise<void> {
  configureLogger()
  settingsManager.applyFreshInstallLocale()

  registerAgentArtifactProtocol()
  scopedLoggers.main.info('IPC services available:', Object.keys(services).join(', '))

  // Renderer handshake mirrors the Electron `app:renderer-ready` flow.
  ipcMain.on('app:renderer-ready', () => {
    void listDesktopSubscriptionsSnapshot()
      .then((snapshot) => emitToRenderer('subscriptions:updated', snapshot))
      .catch((error) => scopedLoggers.main.warn('Failed to broadcast subscriptions:', error))
  })

  const ffmpegInitialization = initializeOptionalTool({
    initialize: () => ffmpegManager.initialize(),
    label: 'ffmpeg',
    logger: scopedLoggers.engine
  })
  const kernelService = initializeYtDlpKernelService()
  kernelService.on('status', (status) => {
    emitToRenderer('ytdlp-kernel:status', status)
  })
  const kernelPreparation = kernelService.prepare()

  await startBridgeServer(CORE_PORT, CORE_TOKEN)
  scopedLoggers.main.info(`Tauri bridge listening on 127.0.0.1:${CORE_PORT}`)

  await Promise.all([ffmpegInitialization, kernelPreparation])

  try {
    runDesktopTaskQueueMigration()
  } catch (error) {
    scopedLoggers.main.warn('Desktop task-queue migration failed:', error)
  }

  try {
    await startDesktopTaskQueue()
    startAutoTranscription()
    subscribeTranscriptBroadcasts()
    startIdleMinimalModelFill()
  } catch (error) {
    scopedLoggers.main.warn('Desktop task queue / transcription failed to start:', error)
  }

  await startExtensionApiServer()

  try {
    await startDesktopSubscriptions()
  } catch (error) {
    scopedLoggers.main.warn('Desktop subscriptions failed to start:', error)
  }

  registerShutdownHook(() => stopYtDlpKernelService())
  registerShutdownHook(() => downloadEngine.flushDownloadSession())
  registerShutdownHook(() => stopPlayerHost())
  registerShutdownHook(() => stopExtensionApiServer())
  registerShutdownHook(async () => {
    await stopDesktopSubscriptions().catch((error) => {
      scopedLoggers.main.warn('Failed to stop desktop subscriptions on quit:', error)
    })
  })
  registerShutdownHook(() => stopDesktopTaskQueue())

  registerShutdownHook(() => stopBridgeServerRuntime())

  scopedLoggers.main.info('VidBee Tauri core is ready')
}

let bridgeStopped = false
async function stopBridgeServerRuntime(): Promise<void> {
  if (bridgeStopped) {
    return
  }
  bridgeStopped = true
  const { stopBridgeServer } = await import('./runtime/bridge-server')
  await stopBridgeServer()
}

process.on('uncaughtException', (error) => {
  scopedLoggers.main.error('Core uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  scopedLoggers.main.error('Core unhandled rejection:', reason)
})

void boot().catch(async (error) => {
  console.error('[vidbee-core] boot failed:', error)
  await runShutdownHooks()
  process.exit(1)
})
