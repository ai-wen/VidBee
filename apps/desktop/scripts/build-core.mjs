#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * Bundle the Tauri sidecar core (Node) with esbuild.
 *
 * The existing Electron main-process code is reused verbatim; the `electron`
 * module and Electron-only packages are redirected to shims under src-core/shims.
 */
import esbuild from 'esbuild'

const desktopRoot = resolve(fileURLToPath(import.meta.url), '../..')
const outdir = resolve(desktopRoot, 'dist-core')
const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))

const nativeExternals = [
  'better-sqlite3',
  'sherpa-onnx-node',
  /^sherpa-onnx-.*/,
  /^jiti(?:\/.*)?$/,
  /^tree-sitter.*/,
  /^@gotgenes\/pi-permission-system(?:\/.*)?$/,
  /^@mzwing\/pi-permission-auto-review(?:\/.*)?$/
]

const isNativeExternal = (id) =>
  nativeExternals.some((entry) =>
    typeof entry === 'string' ? id === entry || id.startsWith(`${entry}/`) : entry.test(id)
  )

const shimResolves = [
  { test: /^electron$/, file: 'src-core/shims/electron.ts' },
  { test: /^electron\/(?!.)/, file: 'src-core/shims/electron.ts' },
  { test: /^electron-log$/, file: 'src-core/shims/electron-log.ts' },
  { test: /^electron-log\/main$/, file: 'src-core/shims/electron-log.ts' },
  { test: /^electron-log\/node$/, file: 'src-core/shims/electron-log.ts' },
  { test: /^electron-store$/, file: 'src-core/shims/electron-store.ts' },
  { test: /^electron-updater$/, file: 'src-core/shims/electron-updater.ts' },
  { test: /^@sentry\/electron(\/.*)?$/, file: 'src-core/shims/sentry-electron-main.ts' },
  { test: /^@electron-toolkit\/utils$/, file: 'src-core/shims/toolkit-utils.ts' },
  { test: /^@better-auth\/electron(\/.*)?$/, file: 'src-core/shims/better-auth-electron.ts' },
  { test: /^electron-ga4-telemetry(\/.*)?$/, file: 'src-core/shims/ga4-transport.ts' }
]

const shimPlugin = {
  name: 'vidbee-electron-shims',
  setup(build) {
    // Electron module + Electron-only packages → local shims.
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) {
        return null
      }
      for (const shim of shimResolves) {
        if (shim.test.test(args.path)) {
          return { path: resolve(desktopRoot, shim.file) }
        }
      }
      return null
    })

    // Native addons stay external so their prebuilt .node binaries load.
    build.onResolve({ filter: /.*/ }, (args) => {
      if (isNativeExternal(args.path)) {
        return { path: args.path, external: true }
      }
      return null
    })

    // `import icon from '../build/icon.png?asset'` → absolute path string.
    build.onResolve({ filter: /\.(png|ico|icns|jpe?g|gif|svg)\?asset$/ }, (args) => {
      return {
        path: resolve(desktopRoot, args.path.replace(/\?asset$/, '')),
        namespace: 'vidbee-asset'
      }
    })
    build.onLoad({ filter: /.*/, namespace: 'vidbee-asset' }, (args) => {
      return {
        contents: `module.exports.default = ${JSON.stringify(args.path)}; module.exports.__esModule = true;`,
        loader: 'js'
      }
    })
  }
}

const define = {
  __GLITCHTIP_DSN__: JSON.stringify(process.env.VITE_GLITCHTIP_DSN || ''),
  __GLITCHTIP_ENVIRONMENT__: JSON.stringify(process.env.VITE_GLITCHTIP_ENVIRONMENT || 'production'),
  __GLITCHTIP_RELEASE__: JSON.stringify(
    process.env.VITE_GLITCHTIP_RELEASE || `vidbee-desktop@${packageJson.version}`
  ),
  'globalThis.__VIDBEE_VERSION__': JSON.stringify(packageJson.version),
  'import.meta.dirname': '__dirname',
  'import.meta.url': '__import_meta_url_shim'
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [
    // Emit core.js at dist-core/main/core.js so `import.meta.dirname`-derived
    // relative paths keep the same depth as the electron-vite out/main layout.
    { in: resolve(desktopRoot, 'src-core/boot.ts'), out: 'main/core' },
    {
      in: resolve(desktopRoot, '../../packages/transcription/src/worker/entry.ts'),
      out: 'transcription-worker'
    },
    { in: resolve(desktopRoot, 'src/main/lib/local-speech-worker.ts'), out: 'speech-worker' }
  ],
  outdir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: [...nativeExternals.filter((entry) => typeof entry === 'string')],
  define,
  banner: {
    js: "const __import_meta_url_shim = require('url').pathToFileURL(__filename).href;"
  },
  alias: {
    '@main': resolve(desktopRoot, 'src/main'),
    '@shared': resolve(desktopRoot, 'src/shared')
  },
  plugins: [shimPlugin],
  logLevel: 'info'
}

await esbuild.build(options)
console.log(`[build-core] bundled to ${outdir}`)
