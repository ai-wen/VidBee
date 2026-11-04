import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { FileSystemIconLoader } from 'unplugin-icons/loaders'
import Icons from 'unplugin-icons/vite'
import { defineConfig, loadEnv } from 'vite'
import { createRendererResolve } from './renderer-react-resolve'

const require = createRequire(import.meta.url)
const lobeIconsDir = join(
  dirname(require.resolve('@lobehub/icons-static-svg/package.json')),
  'icons'
)

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')
) as {
  version: string
}

const createTelemetryDefines = (mode: string): Record<string, string> => {
  const env = loadEnv(mode, process.cwd(), '')
  const release = env.VITE_GLITCHTIP_RELEASE || `vidbee-desktop@${packageJson.version}`
  const environment =
    env.VITE_GLITCHTIP_ENVIRONMENT || (mode === 'production' ? 'production' : mode)

  return {
    __GLITCHTIP_DSN__: JSON.stringify(env.VITE_GLITCHTIP_DSN || ''),
    __GLITCHTIP_ENVIRONMENT__: JSON.stringify(environment),
    __GLITCHTIP_RELEASE__: JSON.stringify(release)
  }
}

/**
 * Plain Vite renderer config for the Tauri build.
 * Mirrors the renderer section of electron.vite.config.ts.
 */
export default defineConfig(({ mode }) => {
  const define = createTelemetryDefines(mode)
  const rendererResolve = createRendererResolve(import.meta.dirname)

  return {
    root: 'src/renderer',
    base: './',
    define,
    server: {
      host: '127.0.0.1',
      port: 5183,
      strictPort: true
    },
    build: {
      outDir: '../../dist-renderer',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 4096
    },
    resolve: rendererResolve,
    optimizeDeps: {
      exclude: [
        '@vidbee/downloader-core',
        '@vidbee/downloader-core/browser-cookies-setting',
        '@vidbee/downloader-core/cookie-setup',
        '@vidbee/downloader-core/filename-style',
        '@vidbee/downloader-core/format-preferences',
        'katex'
      ],
      include: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        '@videojs/react',
        'streamdown',
        '@streamdown/code',
        '@streamdown/math',
        '@streamdown/cjk',
        '@shadcn/react/message-scroller'
      ]
    },
    plugins: [
      react(),
      Icons({
        compiler: 'jsx',
        customCollections: {
          lobehub: FileSystemIconLoader(lobeIconsDir)
        },
        jsx: 'react'
      }),
      tailwindcss()
    ]
  }
})
