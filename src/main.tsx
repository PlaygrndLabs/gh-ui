import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@primer/primitives/dist/css/functional/themes/light.css'
import '@primer/primitives/dist/css/functional/themes/light-high-contrast.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'
import '@primer/primitives/dist/css/functional/themes/dark-dimmed.css'
import '@primer/primitives/dist/css/functional/themes/dark-high-contrast.css'
import '@primer/primitives/dist/css/base/size/size.css'
import '@primer/primitives/dist/css/base/typography/typography.css'
import '@primer/primitives/dist/css/base/motion/motion.css'
import '@primer/primitives/dist/css/functional/size/size.css'
import '@primer/primitives/dist/css/functional/size/border.css'
import '@primer/primitives/dist/css/functional/size/radius.css'
import '@primer/primitives/dist/css/functional/typography/typography.css'
import './styles/markdown.css'
import './styles/app.css'
import App from './App'
import { NativeApp } from './NativeApp'
import { AuthProvider } from './lib/auth'
import { AppThemeProvider } from './lib/theme'
import { native } from './lib/platform'

if (native) {
  document.body.classList.add('is-native', `is-native-${native.platform === 'darwin' ? 'mac' : native.platform}`)
  // Like a browser's tabs, the strip stays one size at any page zoom: it shares its row with the window buttons.
  const syncZoom = () => document.body.style.setProperty('--page-zoom', String(native!.zoomFactor()))
  window.addEventListener('resize', syncZoom)
  syncZoom()
  native.onMenu((action) => {
    if (action.startsWith('fullscreen:')) document.body.classList.toggle('is-fullscreen', action === 'fullscreen:true')
  })
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        const status = (err as { status?: number }).status
        if (status && [401, 403, 404, 409, 410, 422].includes(status)) return false
        // GraphQL answers 200 with errors (missing scopes, not found); retrying won't help.
        if ((err as { name?: string }).name === 'GraphqlResponseError') return false
        return count < 2
      },
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppThemeProvider>
        <AuthProvider>
          {/* The desktop app gives each tab its own router; browsers already have tabs. */}
          {native ? (
            <NativeApp />
          ) : (
            <BrowserRouter>
              <App />
            </BrowserRouter>
          )}
        </AuthProvider>
      </AppThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
