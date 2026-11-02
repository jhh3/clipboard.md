import { useEffect, useState } from 'react'
import Palette from './components/Palette'
import Settings from './components/Settings'
import DictationHud from './components/DictationHud'

type Route = 'palette' | 'settings' | 'dictation'

function routeFromHash(): Route {
  const h = window.location.hash
  if (h === '#settings') return 'settings'
  if (h === '#dictation') return 'dictation'
  return 'palette'
}

/**
 * Tiny hash router: '' / '#palette' → palette, '#settings' → settings,
 * '#dictation' → the always-on-top dictation HUD.
 */
export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash)

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Body class per route: the settings window is opaque (no palette shadow margin);
  // the dictation HUD keeps a thin one for its own shadow.
  useEffect(() => {
    document.body.className = `route-${route}`
  }, [route])

  if (route === 'settings') return <Settings />
  if (route === 'dictation') return <DictationHud />
  return <Palette />
}
