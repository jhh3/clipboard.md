/**
 * Which capability rows Settings is allowed to write a notice about.
 *
 * WINDOWS ONLY, and that gate is the entire reason this is a function instead of a
 * `.filter()` inline in the component. The capability registry describes all three
 * platforms, so filtering it on `state !== 'supported'` alone put a line into the
 * macOS Settings pane reading "Rewrite selection (unavailable) — macOS has no
 * PRIMARY selection", about a mechanism macOS has never had and that the rewrite
 * hotkey does not use there (it reads the real selection through the accessibility
 * API and works). Linux likewise gained a line about _NET_ACTIVE_WINDOW. Both panes
 * are supposed to be untouched by the Windows port: the notices exist because
 * Windows v1 ships a deliberately narrow feature set and says so, not because the
 * registry has a row for every platform.
 *
 * Pure, and given the platform rather than reading it, so a test can put the real
 * `capabilitiesFor('darwin')` through it and assert that nothing comes out.
 */

export interface CapabilityLike {
  state: string
  reason: string
}

export interface CapabilityNotice {
  key: string
  state: string
  reason: string
}

export function capabilityNotices(
  caps: Record<string, CapabilityLike>,
  platform: string
): CapabilityNotice[] {
  if (platform !== 'win32') return []
  return Object.entries(caps)
    .filter(([, v]) => v.state !== 'supported')
    .map(([key, v]) => ({ key, state: v.state, reason: v.reason }))
}
