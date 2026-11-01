import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BaseStyles, ThemeProvider } from '@primer/react'
import { readPref, writePref } from './storage'

export type ThemeChoice = 'auto' | 'light' | 'dark' | 'dark_dimmed' | 'light_high_contrast' | 'dark_high_contrast'

export const THEME_LABEL: Record<ThemeChoice, string> = {
  auto: 'Sync with system',
  light: 'Light default',
  light_high_contrast: 'Light high contrast',
  dark: 'Dark default',
  dark_dimmed: 'Dark dimmed',
  dark_high_contrast: 'Dark high contrast',
}

interface ThemeState {
  theme: ThemeChoice
  setTheme(t: ThemeChoice): void
}

const ThemeContext = createContext<ThemeState>({ theme: 'auto', setTheme: () => {} })

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(() => readPref<ThemeChoice>('theme', 'auto'))

  // Primer primitives key their CSS variables off these attributes; setting them on
  // <html> means portals and overlays outside the React tree pick up the theme too.
  useEffect(() => {
    const el = document.documentElement
    if (theme === 'auto') {
      el.dataset.colorMode = 'auto'
      el.dataset.lightTheme = 'light'
      el.dataset.darkTheme = 'dark'
    } else if (theme.startsWith('light')) {
      el.dataset.colorMode = 'light'
      el.dataset.lightTheme = theme
      el.dataset.darkTheme = 'dark'
    } else {
      el.dataset.colorMode = 'dark'
      el.dataset.lightTheme = 'light'
      el.dataset.darkTheme = theme
    }
  }, [theme])

  const value = useMemo<ThemeState>(
    () => ({
      theme,
      setTheme(t) {
        setThemeState(t)
        writePref('theme', t)
      },
    }),
    [theme],
  )

  const colorMode = theme === 'auto' ? 'auto' : theme.startsWith('light') ? 'day' : 'night'
  return (
    <ThemeContext.Provider value={value}>
      <ThemeProvider colorMode={colorMode} dayScheme="light" nightScheme="dark">
        <BaseStyles>{children}</BaseStyles>
      </ThemeProvider>
    </ThemeContext.Provider>
  )
}

export function useAppTheme() {
  return useContext(ThemeContext)
}
