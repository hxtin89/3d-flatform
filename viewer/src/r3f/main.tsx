import './dev/console-tap'
import { createRoot } from 'react-dom/client'
import './r3f.css'
import { App } from './App'
// Kicks off the donation GeoJSON fetch at module load (side effect of params.ts).
import './params'

const root = createRoot(document.getElementById('root')!)
root.render(<App />)

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) root.unmount()
})
