import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Tests import main-process modules directly, and those use the same `@shared`
// alias the electron-vite build resolves — vitest needs to be told about it too.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  }
})
