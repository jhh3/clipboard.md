import { app, session, shell, type WebContents } from 'electron'

/**
 * Process-wide hardening. This app holds an aggregate of everything the user has
 * copied — including credentials — so the renderer is treated as untrusted even
 * though we author it.
 */
export function hardenApp(): void {
  // Defence in depth: we never intend to open a webview or a second window.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      // External links go to the user's browser; nothing opens in-app.
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (e, url) => {
      // The renderer is a local SPA: any navigation away from it is a bug or an attack.
      const allowed = process.env.ELECTRON_RENDERER_URL
      if (!allowed || !url.startsWith(allowed)) e.preventDefault()
    })
  })
}

/** Deny-by-default permissions; the app needs the microphone and nothing else. */
export function applyPermissionPolicy(): void {
  const ses = session.defaultSession
  const ALLOWED = new Set(['media', 'clipboard-sanitized-write'])

  // Flush anything granted in a previous run before installing the policy.
  ses.setPermissionRequestHandler(null)
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission))
  // No app code enumerates USB/serial/HID devices.
  ses.setDevicePermissionHandler(() => false)
}

/**
 * IPC sender guard. Every handler runs with the full privileges of the main
 * process, so confirm the caller is one of our own windows and not, say, a frame
 * that navigated somewhere unexpected.
 */
export function isTrustedSender(contents: WebContents): boolean {
  const url = contents.getURL()
  if (!url) return false
  if (process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL)
  return url.startsWith('file://')
}
