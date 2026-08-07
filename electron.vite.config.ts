import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        external: [
          'electron',
          'better-sqlite3',
          'sqlite-vec',
          'zod',
          'dbus-next',
          'sharp',
          'tesseract.js',
          '@huggingface/transformers',
          '@anthropic-ai/claude-agent-sdk',
          '@openai/codex-sdk'
        ],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          embedWorker: resolve(__dirname, 'src/main/embeddings/worker.ts'),
          mcp: resolve(__dirname, 'src/mcp/server.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: { external: ['electron'] }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
