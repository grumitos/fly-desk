import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import './index.css'
import App from './App.tsx'

try {
  window.localStorage.removeItem('flydesk-location-suggestion-details-v1')
} catch {
  // The retired browser cache may be inaccessible in hardened contexts.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
)
