import { BROWSER_STYLE_CSS_PROPERTIES, BROWSER_STYLE_FONTS, BROWSER_STYLE_RANGES, type BrowserStyleChanges, type BrowserStyleProperty } from '../../shared/browser-style-types'

export function normalizeBrowserStyleChanges(raw: unknown): { values: BrowserStyleChanges; css: Partial<Record<BrowserStyleProperty, string>> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('样式修改必须是字段对象。')
  const values: BrowserStyleChanges = {}, css: Partial<Record<BrowserStyleProperty, string>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(BROWSER_STYLE_CSS_PROPERTIES, key)) throw new Error('样式字段不受支持。')
    const property = key as BrowserStyleProperty
    if (property === 'fontFamily') {
      if (typeof value !== 'string' || !Object.hasOwn(BROWSER_STYLE_FONTS, value)) throw new Error('请选择提供的字体类别。')
      values.fontFamily = value as NonNullable<BrowserStyleChanges['fontFamily']>; css.fontFamily = BROWSER_STYLE_FONTS[values.fontFamily]
    } else if (property === 'color' || property === 'backgroundColor') {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) throw new Error('颜色必须为六位或八位十六进制色值。')
      values[property] = value.toLowerCase(); css[property] = value.toLowerCase()
    } else {
      const [min, max] = BROWSER_STYLE_RANGES[property]!
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || property === 'fontWeight' && (!Number.isInteger(value) || value % 100 !== 0)) throw new Error(`${property} 的数值超出允许范围。`)
      const number = Math.round(value * 100) / 100
      values[property] = number; css[property] = property === 'fontWeight' ? String(number) : `${number}px`
    }
  }
  return { values, css }
}
