import type { PreloadApi } from './index'

declare global {
  interface Window {
    clipmd: PreloadApi
  }
}

export {}
