import { useEffect } from 'react'
import { useStore } from './store'
import { desktopFontStack, normalizeDesktopFonts } from '../../shared/desktop-fonts'
import { DESKTOP_THEME_TOKEN_NAMES, desktopThemeTokens, normalizeDesktopPersonalization, normalizeDesktopThemeColors, type DesktopColorMode, type DesktopThemeColors } from '../../shared/desktop-personalization'
import './desktop-personalization.css'

export const DESKTOP_FONTS_CHANGED = 'caogen:desktop-fonts-changed'
export const DESKTOP_THEME_CHANGED = 'caogen:desktop-theme-changed'
let activePreview: { token: symbol; mode: DesktopColorMode; colors: DesktopThemeColors } | undefined

function applyCurrentTheme(): void {
  const settings = useStore.getState().settings
  const root = document.documentElement
  const mode = activePreview?.mode ?? (settings.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme)
  const colors = activePreview?.colors ?? normalizeDesktopPersonalization(settings.desktopPersonalization).colors
  const overrides = colors[mode], custom = Object.keys(overrides).length > 0
  root.setAttribute('data-theme', mode)
  root.setAttribute('data-custom-colors', String(custom))
  const tokens = custom ? desktopThemeTokens(mode, overrides) : undefined
  for (const name of DESKTOP_THEME_TOKEN_NAMES) {
    const alias = `--desktop-theme-${name.slice(2)}`
    if (tokens) { root.style.setProperty(name, tokens[name]); root.style.setProperty(alias, tokens[name]) }
    else { root.style.removeProperty(name); root.style.removeProperty(alias) }
  }
  window.dispatchEvent(new Event(DESKTOP_THEME_CHANGED))
}

/** Temporary, renderer-local preview. Cleanup restores the latest saved settings. */
export function previewDesktopTheme(mode: DesktopColorMode, colors: DesktopThemeColors): () => void {
  const token = Symbol('desktop-theme-preview')
  activePreview = { token, mode, colors: normalizeDesktopThemeColors(colors) }
  applyCurrentTheme()
  return () => { if (activePreview?.token === token) { activePreview = undefined; applyCurrentTheme() } }
}

/**
 * 把 settings.theme 解析为实际主题并写到 <html data-theme>。
 * system 时跟随 prefers-color-scheme 并监听切换。
 */
export function useThemeEffect(): void {
  const theme = useStore((s) => s.settings.theme)
  const fonts = useStore((s) => s.settings.desktopFonts)
  const personalization = useStore((s) => s.settings.desktopPersonalization)

  useEffect(() => {
    const value = normalizeDesktopFonts(fonts), root = document.documentElement
    const interfaceStack = desktopFontStack(value.interfaceFamily)
    const codeStack = desktopFontStack(value.codeFamily, true)
    root.style.setProperty('--sans', interfaceStack)
    root.style.setProperty('--desktop-interface-font', interfaceStack)
    for (const name of ['--mono', '--mono-font', '--font-mono']) root.style.setProperty(name, codeStack)
    window.dispatchEvent(new Event(DESKTOP_FONTS_CHANGED))
  }, [fonts])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    applyCurrentTheme()
    mq.addEventListener('change', applyCurrentTheme)
    return () => mq.removeEventListener('change', applyCurrentTheme)
  }, [theme, personalization])
}
