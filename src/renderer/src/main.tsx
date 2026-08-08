import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Before first paint, so the mac-native window shadow rules apply without a flash of
// the CSS-shadow layout (which reserves a 40px margin the mac path must not have).
document.documentElement.dataset.platform = window.clipmd?.platform ?? 'linux'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
