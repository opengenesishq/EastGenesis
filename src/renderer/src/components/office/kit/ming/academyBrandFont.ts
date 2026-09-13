export const CAOTAI_BRAND_FONT = 'CaoTaiHub Noto Serif'
let loading: Promise<boolean> | undefined

/** Unmodified Noto Serif Latin 600, bundled with SIL OFL 1.1 in public/fonts. */
export function loadAcademyBrandFont(): Promise<boolean> {
  if (!loading) {
    const url = new URL('./fonts/noto-serif/NotoSerif-Latin-600.woff2', document.baseURI).href
    loading = new FontFace(CAOTAI_BRAND_FONT, `url("${url}")`, { weight: '600', style: 'normal' })
      .load().then((face) => { document.fonts.add(face); return true })
      .catch((error) => { console.error('[CaoTaiHub] Brand font could not load', error); return false })
  }
  return loading
}
