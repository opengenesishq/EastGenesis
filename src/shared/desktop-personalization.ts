export type DesktopColorMode = 'light' | 'dark'
export interface DesktopPaletteOverrides { accent?: string; background?: string; foreground?: string }
export interface DesktopThemeColors { light: DesktopPaletteOverrides; dark: DesktopPaletteOverrides }
export const LOCAL_PROFILE_EMOJIS = ['🌱', '👑', '🏯', '🧑‍💻', '🦊', '🐼', '🐈', '🚀', '🎨', '🧭'] as const
export interface DesktopLocalProfile { displayName: string; avatarStyle: 'initial' | 'emoji'; emoji: string }
export interface DesktopPersonalizationSettings { colors: DesktopThemeColors; profile: DesktopLocalProfile }
export const DEFAULT_DESKTOP_PERSONALIZATION: DesktopPersonalizationSettings = {
  colors: { light: {}, dark: {} }, profile: { displayName: '', avatarStyle: 'initial', emoji: '🌱' }
}
export const DEFAULT_DESKTOP_PALETTES: Record<DesktopColorMode, Required<DesktopPaletteOverrides>> = {
  light: { background: '#f6f6f6', foreground: '#161616', accent: '#161616' },
  dark: { background: '#0d0d0d', foreground: '#f4f4f4', accent: '#f4f4f4' }
}
export const DESKTOP_THEME_JSON_MAX_LENGTH = 8_192
export const DESKTOP_PERSONA_MAX_LENGTH = 12_000

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label}包含不支持的字段或格式。`)
  }
  return value as Record<string, unknown>
}
function palette(value: unknown): DesktopPaletteOverrides {
  if (value === undefined) return {}
  const input = object(value, ['accent', 'background', 'foreground'], '主题颜色'), output: DesktopPaletteOverrides = {}
  for (const key of ['accent', 'background', 'foreground'] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input[key])) throw new Error('主题颜色须使用完整的 #RRGGBB 十六进制格式。')
    output[key] = input[key].toLowerCase()
  }
  return output
}
export function normalizeDesktopThemeColors(value: unknown): DesktopThemeColors {
  if (value === undefined || value === null) return { light: {}, dark: {} }
  const input = object(value, ['light', 'dark'], '主题')
  const colors = { light: palette(input.light), dark: palette(input.dark) }
  for (const mode of ['light', 'dark'] as const) {
    if (desktopThemeContrast(mode, colors[mode]) < 4.5) throw new Error(`${mode === 'light' ? '浅色' : '深色'}主题文字与背景对比度不足，请调整颜色。`)
    const resolved = { ...DEFAULT_DESKTOP_PALETTES[mode], ...colors[mode] }
    if (contrastRatio(resolved.accent, resolved.background) < 3) throw new Error(`${mode === 'light' ? '浅色' : '深色'}主题强调色与背景过于接近，请调整颜色。`)
  }
  return colors
}
export function normalizeDesktopPersonalization(value: unknown): DesktopPersonalizationSettings {
  if (value === undefined || value === null) return structuredClone(DEFAULT_DESKTOP_PERSONALIZATION)
  const input = object(value, ['colors', 'profile'], '个性化设置')
  const profile = input.profile === undefined ? {} : object(input.profile, ['displayName', 'avatarStyle', 'emoji'], '个人资料')
  const name = profile.displayName === undefined ? '' : profile.displayName
  if (typeof name !== 'string' || name.length > 60 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)) throw new Error('本地显示名须为 0–60 个字符，不能包含控制字符。')
  if (profile.avatarStyle !== undefined && profile.avatarStyle !== 'initial' && profile.avatarStyle !== 'emoji') throw new Error('头像仅支持首字或内置图标。')
  const emoji = profile.emoji ?? '🌱'
  if (typeof emoji !== 'string' || !LOCAL_PROFILE_EMOJIS.some(item => item === emoji)) throw new Error('请选择内置头像图标。')
  return { colors: normalizeDesktopThemeColors(input.colors), profile: { displayName: name.trim(), avatarStyle: profile.avatarStyle === 'emoji' ? 'emoji' : 'initial', emoji } }
}
export function parseDesktopThemeJson(text: string): DesktopThemeColors {
  if (typeof text !== 'string' || text.length > DESKTOP_THEME_JSON_MAX_LENGTH) throw new Error('主题 JSON 不得超过 8 KB。')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('主题文件不是有效 JSON。') }
  const input = object(raw, ['format', 'version', 'colors'], '主题文件')
  if (input.format !== 'caogen-theme' || input.version !== 1 || input.colors === undefined) throw new Error('主题文件格式或版本不受支持。')
  return normalizeDesktopThemeColors(input.colors)
}
/** Exports colors only. Never includes local profile, instructions, providers, or credentials. */
export function serializeDesktopThemeJson(colors: DesktopThemeColors): string {
  return `${JSON.stringify({ format: 'caogen-theme', version: 1, colors: normalizeDesktopThemeColors(colors) }, null, 2)}\n`
}
export function desktopProfileAvatar(profile: DesktopLocalProfile, language: 'zh' | 'en'): string {
  if (profile.avatarStyle === 'emoji') return LOCAL_PROFILE_EMOJIS.some(item => item === profile.emoji) ? profile.emoji : '🌱'
  const name = profile.displayName.trim()
  if (!name) return language === 'zh' ? '曹' : 'C'
  const segment = new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(name)[Symbol.iterator]().next().value
  return String(segment?.segment ?? Array.from(name)[0]).toLocaleUpperCase().slice(0, 20)
}
function rgb(hex: string): number[] { return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) }
function luminance(hex: string): number {
  const channels = rgb(hex).map(value => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
export function contrastRatio(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
export function desktopThemeContrast(mode: DesktopColorMode, overrides: DesktopPaletteOverrides): number {
  const colors = { ...DEFAULT_DESKTOP_PALETTES[mode], ...overrides }
  return contrastRatio(colors.background, colors.foreground)
}
function blend(a: string, b: string, amount: number): string {
  const x = rgb(a), y = rgb(b)
  return `#${x.map((value, index) => Math.round(value * (1 - amount) + y[index] * amount).toString(16).padStart(2, '0')).join('')}`
}
export const DESKTOP_THEME_TOKEN_NAMES = ['--bg', '--bg-raised', '--bg-card', '--bg-input', '--border', '--border-soft', '--text', '--text-dim', '--text-faint', '--accent', '--accent-hover', '--accent-soft', '--accent-text'] as const
export type DesktopThemeTokens = Record<(typeof DESKTOP_THEME_TOKEN_NAMES)[number], string>
/** Produces only fixed CSS variable names and computed hex values, never CSS source. */
export function desktopThemeTokens(mode: DesktopColorMode, overrides: DesktopPaletteOverrides): DesktopThemeTokens {
  const { background, foreground, accent } = { ...DEFAULT_DESKTOP_PALETTES[mode], ...palette(overrides) }
  const raised = blend(background, foreground, mode === 'dark' ? 0.045 : 0.02)
  return { '--bg': background, '--bg-raised': raised, '--bg-card': blend(background, foreground, 0.07), '--bg-input': blend(background, mode === 'dark' ? '#000000' : '#ffffff', 0.5),
    '--border': blend(background, foreground, 0.2), '--border-soft': blend(background, foreground, 0.12), '--text': foreground,
    '--text-dim': blend(foreground, background, 0.25), '--text-faint': blend(foreground, background, 0.4), '--accent': accent,
    '--accent-hover': blend(accent, foreground, 0.12), '--accent-soft': blend(background, accent, 0.14),
    '--accent-text': contrastRatio(accent, '#000000') >= contrastRatio(accent, '#ffffff') ? '#000000' : '#ffffff' }
}

export type DesktopPersonaPresetId = 'friendly' | 'pragmatic' | 'detailed'
export const DESKTOP_PERSONA_PRESETS: Array<{ id: DesktopPersonaPresetId; name: { zh: string; en: string }; text: { zh: string; en: string } }> = [
  { id: 'friendly', name: { zh: '友好协作', en: 'Friendly' }, text: { zh: '使用自然、友好的语气。先明确回答，再补充必要解释；遇到不确定信息时直接说明。与我协作推进任务，避免奉承和冗长开场。', en: 'Use a natural, friendly tone. Answer directly, then add the explanation needed. State uncertainty clearly. Collaborate to move the task forward without flattery or long introductions.' } },
  { id: 'pragmatic', name: { zh: '务实简洁', en: 'Pragmatic' }, text: { zh: '优先给出可执行的结果和下一步。表达简洁具体，说明关键取舍、真实限制和完成依据。必要时指出问题，不为迎合而改变事实。', en: 'Prioritize useful results and actionable next steps. Be concise and specific about tradeoffs, real limitations, and evidence of completion. Point out problems when needed and keep facts accurate.' } },
  { id: 'detailed', name: { zh: '充分解释', en: 'Detailed' }, text: { zh: '为重要结论提供清晰依据、必要背景和具体例子。把复杂工作拆成可理解的步骤，说明假设和验证结果，同时避免重复与无关细节。', en: 'Support important conclusions with clear evidence, useful context, and concrete examples. Explain complex work in understandable steps, including assumptions and verification, while avoiding repetition and irrelevant detail.' } }
]
export function applyDesktopPersonaPreset(current: string, preset: string, mode: 'append' | 'replace'): string {
  if (typeof current !== 'string' || typeof preset !== 'string' || /\u0000/.test(current + preset)) throw new Error('自定义指令格式无效。')
  const text = preset.trim()
  if (!text) throw new Error('请先填写预设指令内容。')
  const result = mode === 'replace' ? text : current.trim() ? `${current.trim()}\n\n${text}` : text
  if (result.length > DESKTOP_PERSONA_MAX_LENGTH) throw new Error('应用后自定义指令不能超过 12,000 个字符。')
  return result
}
