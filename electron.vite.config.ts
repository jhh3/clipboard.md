import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    // double-metaphone is a tiny, pure ESM package used by the corrections matcher;
    // bundle it rather than externalize so the packaged (ESM) main has no runtime
    // node_modules resolution to get wrong — the kind of ESM/CJS trap we've hit before.
    plugins: [externalizeDepsPlugin({ exclude: ['double-metaphone'] })],
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
          'x11',
          'sherpa-onnx-node',
          '@huggingface/transformers',
          '@anthropic-ai/claude-agent-sdk',
          '@openai/codex-sdk'
        ],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          embedWorker: resolve(__dirname, 'src/main/embeddings/worker.ts'),
          asrWorker: resolve(__dirname, 'src/main/asr/worker.ts'),
          mcp: resolve(__dirname, 'src/mcp/server.ts'),
          // Per-session two-way channel, spawned by agents.ts as an MCP server.
          bridge: resolve(__dirname, 'src/mcp/bridge.ts')
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
