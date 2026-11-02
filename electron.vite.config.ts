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
          'x11',
          'sherpa-onnx-node',
          '@huggingface/transformers',
          // OCR worker: a native addon, and a model package that locates its files
          // relative to itself (bundled, it would look beside out/main instead).
          'onnxruntime-node',
          /^@gutenye\/ocr-models/
        ],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          embedWorker: resolve(__dirname, 'src/main/embeddings/worker.ts'),
          asrWorker: resolve(__dirname, 'src/main/asr/worker.ts'),
          ocrWorker: resolve(__dirname, 'src/main/ocr/worker.ts')
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
