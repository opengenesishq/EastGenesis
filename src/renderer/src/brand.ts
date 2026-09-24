import appIconUrl from '../../../resources/icon.png?url'

/** Product-facing identity. Keep the historical caogen namespace internal for migration safety. */
export const APP_NAME = 'EastGenesis'
export const APP_ICON_URL = appIconUrl

/** Palace/3D is retained as an experimental implementation, not a current product entry point. */
export const ENABLE_PALACE_EXPERIENCE = false

export const BRAND_COLORS = {
  orientalRed: '#D60000',
  chineseGold: '#FFC700'
} as const
