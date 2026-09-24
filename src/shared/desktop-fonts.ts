export interface DesktopFontSettings { interfaceFamily: string; codeFamily: string }
export const DEFAULT_DESKTOP_FONTS: DesktopFontSettings = { interfaceFamily: 'system', codeFamily: 'system' }
export const INTERFACE_FONT_CHOICES = ['system', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'Helvetica Neue', 'Arial', 'Segoe UI', 'Inter', 'Songti SC', 'Noto Serif SC'] as const
export const CODE_FONT_CHOICES = ['system', 'SF Mono', 'Menlo', 'Monaco', 'Consolas', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Noto Sans Mono'] as const

function fontFamily(value: unknown): string {
  if (typeof value !== 'string') return 'system'
  const name = value.trim()
  // A single local family name only, never CSS expressions, URL imports, or remote font downloads.
  return name && name.length <= 100 && /^[\p{L}\p{N} ._-]+$/u.test(name) ? name : 'system'
}
export function normalizeDesktopFonts(value: unknown): DesktopFontSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<DesktopFontSettings> : {}
  return { interfaceFamily: fontFamily(input.interfaceFamily), codeFamily: fontFamily(input.codeFamily) }
}
export function desktopFontStack(value: string, code = false): string {
  const fallback = code ? "'SF Mono', ui-monospace, Menlo, Consolas, monospace" : "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif"
  const family = fontFamily(value)
  return family === 'system' ? fallback : `"${family}", ${fallback}`
}
