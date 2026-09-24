import type { BrowserTabTarget } from './browser-tab-types'

export type BrowserStyleProperty = 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'letterSpacing' | 'color' | 'backgroundColor'
  | 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft'
export type BrowserStyleFont = 'system' | 'sans' | 'serif' | 'mono'
export interface BrowserStyleChanges {
  fontFamily?: BrowserStyleFont; fontSize?: number; fontWeight?: number; lineHeight?: number; letterSpacing?: number
  color?: string; backgroundColor?: string
  marginTop?: number; marginRight?: number; marginBottom?: number; marginLeft?: number
  paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number
}
export interface BrowserStyleDifference { property: BrowserStyleProperty; before: string; after: string }
export interface BrowserStylePreview {
  id: string; target: BrowserTabTarget; revision: number; selector: string; tagName: string; url: string
  computed: Record<BrowserStyleProperty, string>; changes: BrowserStyleDifference[]
  values: BrowserStyleChanges; status: 'selected' | 'previewing' | 'reverted' | 'conflict'; conflicts: BrowserStyleProperty[]; expiresAt: number
}
export interface BrowserStyleReference { previewId: string; target: BrowserTabTarget; expectedRevision: number }
export interface BrowserStyleApi {
  pickBrowserStyleTarget(target: BrowserTabTarget, previewId: string): Promise<{ cancelled: true } | { cancelled: false; preview: BrowserStylePreview }>
  previewBrowserStyles(input: BrowserStyleReference & { changes: BrowserStyleChanges }): Promise<BrowserStylePreview>
  revertBrowserStyles(input: BrowserStyleReference): Promise<BrowserStylePreview>
  getBrowserStyleDraft(input: BrowserStyleReference): Promise<{ sessionId: string; deliveryId: string; text: string }>
  releaseBrowserStylePreview(input: { previewId: string; target: BrowserTabTarget }): Promise<void>
}
export const BROWSER_STYLE_PROPERTIES: BrowserStyleProperty[] = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
export const BROWSER_STYLE_CSS_PROPERTIES: Record<BrowserStyleProperty, string> = {
  fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight', lineHeight: 'line-height', letterSpacing: 'letter-spacing', color: 'color', backgroundColor: 'background-color',
  marginTop: 'margin-top', marginRight: 'margin-right', marginBottom: 'margin-bottom', marginLeft: 'margin-left',
  paddingTop: 'padding-top', paddingRight: 'padding-right', paddingBottom: 'padding-bottom', paddingLeft: 'padding-left'
}
export const BROWSER_STYLE_FONTS: Record<BrowserStyleFont, string> = { system: 'system-ui', sans: 'sans-serif', serif: 'serif', mono: 'monospace' }
export const BROWSER_STYLE_RANGES: Partial<Record<BrowserStyleProperty, [number, number]>> = {
  fontSize: [8, 120], fontWeight: [100, 900], lineHeight: [8, 200], letterSpacing: [-5, 50],
  marginTop: [0, 256], marginRight: [0, 256], marginBottom: [0, 256], marginLeft: [0, 256],
  paddingTop: [0, 256], paddingRight: [0, 256], paddingBottom: [0, 256], paddingLeft: [0, 256]
}
