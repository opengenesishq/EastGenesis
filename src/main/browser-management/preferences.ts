import { isAbsolute } from 'node:path'
import { realpathSync, statSync } from 'node:fs'
import type { BrowserPreferences, BrowserSiteAccess, BrowserSiteRule } from '../../shared/browser-preferences-types'
import { redactSensitiveText } from '../security/secret-redaction'

export function browserOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'blob:') return browserOrigin(url.pathname)
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined
  } catch { return undefined }
}
export function browserLogUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return redactSensitiveText(url.href).slice(0, 2_000)
  } catch { return '' }
}
export function browserLogTitle(value: string): string { return redactSensitiveText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240) }
export function defaultBrowserPreferences(downloadDirectory: string): BrowserPreferences {
  return { recordHistory: false, retentionDays: 30, downloadDirectory, askDownloadLocation: true, defaultSiteAccess: 'allow', siteRules: [] }
}
export function normalizeBrowserPreferences(value: unknown, validateDirectory = false): BrowserPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器设置格式无效。')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['recordHistory', 'retentionDays', 'downloadDirectory', 'askDownloadLocation', 'defaultSiteAccess', 'siteRules'].includes(key)) ||
    typeof raw.recordHistory !== 'boolean' || typeof raw.askDownloadLocation !== 'boolean' || !Number.isSafeInteger(raw.retentionDays) ||
    Number(raw.retentionDays) < 1 || Number(raw.retentionDays) > 365 || typeof raw.downloadDirectory !== 'string' ||
    !isAbsolute(raw.downloadDirectory) || raw.downloadDirectory.includes('\0') || !Array.isArray(raw.siteRules) || raw.siteRules.length > 500) throw new Error('浏览器设置字段无效。')
  const access = (item: unknown): BrowserSiteAccess => { if (item !== 'allow' && item !== 'block') throw new Error('站点规则必须为允许或阻止。'); return item }
  const seen = new Set<string>()
  const siteRules = raw.siteRules.map((item: unknown): BrowserSiteRule => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('站点规则格式无效。')
    const rule = item as Record<string, unknown>
    if (Object.keys(rule).some(key => !['origin', 'access', 'downloads'].includes(key)) || typeof rule.origin !== 'string') throw new Error('站点规则格式无效。')
    const parsed = new URL(rule.origin), origin = browserOrigin(rule.origin)
    if (!origin || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || seen.has(origin)) throw new Error('请输入不含路径、账号、参数的唯一 http(s) 站点地址。')
    seen.add(origin)
    return { origin, access: access(rule.access), downloads: rule.downloads === 'inherit' ? 'inherit' : access(rule.downloads) }
  })
  let directory = raw.downloadDirectory
  if (validateDirectory) { directory = realpathSync(directory); if (!statSync(directory).isDirectory()) throw new Error('下载位置必须是现有目录。') }
  return { recordHistory: raw.recordHistory, retentionDays: Number(raw.retentionDays), downloadDirectory: directory,
    askDownloadLocation: raw.askDownloadLocation, defaultSiteAccess: access(raw.defaultSiteAccess), siteRules }
}
export function browserSiteDecision(preferences: BrowserPreferences, url: string): { origin?: string; access: BrowserSiteAccess; downloads: BrowserSiteAccess; ruleSource: 'default' | 'origin' } {
  const origin = browserOrigin(url), rule = preferences.siteRules.find(item => item.origin === origin)
  const access = rule?.access ?? preferences.defaultSiteAccess
  return { origin, access, downloads: access === 'block' ? 'block' : rule?.downloads === 'block' ? 'block' : 'allow', ruleSource: rule ? 'origin' : 'default' }
}
