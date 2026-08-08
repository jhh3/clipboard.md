import { useEffect, useState } from 'react'
import Palette from './components/Palette'
import Settings from './components/Settings'
import Scratchpad from './components/Scratchpad'
import DictationHud from './components/DictationHud'
import Notes from './components/Notes'

type Route = 'palette' | 'settings' | 'scratchpad' | 'dictation' | 'notes'

function routeFromHash(): Route {
  const h = window.location.hash
  if (h === '#settings') return 'settings'
  if (h === '#scratchpad') return 'scratchpad'
  if (h === '#dictation') return 'dictation'
  if (h === '#notes') return 'notes'
  return 'palette'
}

/**
 * Tiny hash router: '' / '#palette' → palette, '#settings' → settings,
 * '#scratchpad' → scratchpad, '#dictation' → the always-on-top dictation HUD.
 */
export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash)

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Body class per route: settings/scratchpad windows are opaque (no palette
  // shadow margin); the dictation HUD keeps a thin one for its own shadow.
  useEffect(() => {
    document.body.className = `route-${route}`
  }, [route])

  if (route === 'settings') return <Settings />
  if (route === 'scratchpad') return <Scratchpad />
  if (route === 'dictation') return <DictationHud />
  if (route === 'notes') return <Notes />
  return <Palette />
}
