import { useEffect, useState } from 'react'
import Palette from './components/Palette'
import Settings from './components/Settings'
import Scratchpad from './components/Scratchpad'

type Route = 'palette' | 'settings' | 'scratchpad'

function routeFromHash(): Route {
  const h = window.location.hash
  if (h === '#settings') return 'settings'
  if (h === '#scratchpad') return 'scratchpad'
  return 'palette'
}

/** Tiny hash router: '' / '#palette' → palette, '#settings' → settings, '#scratchpad' → scratchpad. */
export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash)

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Body class per route: settings/scratchpad windows are opaque (no palette shadow margin).
  useEffect(() => {
    document.body.className = `route-${route}`
  }, [route])

  if (route === 'settings') return <Settings />
  if (route === 'scratchpad') return <Scratchpad />
  return <Palette />
}
