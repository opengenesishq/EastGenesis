export interface DesktopGitPreferences {
  branchPrefix: string
  commitTemplate: string
  pullRequestTitleTemplate: string
  pullRequestBodyTemplate: string
}
export interface GitTextTemplateContext { title: string; branch: string; baseBranch: string; summary: string }
export const DEFAULT_DESKTOP_GIT_PREFERENCES: DesktopGitPreferences = {
  branchPrefix: 'caogen', commitTemplate: '',
  pullRequestTitleTemplate: '{branch}: CaoGen worktree changes',
  pullRequestBodyTemplate: 'Automated pull request for CaoGen managed worktree `{branch}`.\n\nBase branch: `{baseBranch}`\n\n{summary}'
}
const placeholders = new Set(['title', 'branch', 'baseBranch', 'summary'])
export function normalizeGitBranchPrefix(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Git 分支前缀必须是文本。')
  const prefix = value.trim().replace(/\/+$/, '')
  if (!prefix || prefix.length > 80 || prefix.startsWith('-') || /[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(prefix) || prefix.includes('..') || prefix.includes('@{') ||
    prefix.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('Git 分支前缀无效；请使用 caogen 或 team/feature 这样的名称。')
  return prefix
}
function template(value: unknown, limit: number, singleLine: boolean): string {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || singleLine && /[\r\n]/.test(value)) throw new Error(`Git 文案格式无效或超过 ${limit} 个字符。`)
  for (const match of value.matchAll(/\{([a-zA-Z_][a-zA-Z_0-9]*)\}/g)) if (!placeholders.has(match[1])) throw new Error(`不支持的模板字段：${match[0]}`)
  return value
}
export function normalizeDesktopGitPreferences(raw: unknown): DesktopGitPreferences {
  if (raw === undefined || raw === null) return { ...DEFAULT_DESKTOP_GIT_PREFERENCES }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Git 偏好格式无效。')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !(key in DEFAULT_DESKTOP_GIT_PREFERENCES))) throw new Error('Git 偏好包含未知字段。')
  return {
    branchPrefix: normalizeGitBranchPrefix(value.branchPrefix ?? DEFAULT_DESKTOP_GIT_PREFERENCES.branchPrefix),
    commitTemplate: template(value.commitTemplate ?? '', 2_000, false),
    pullRequestTitleTemplate: template(value.pullRequestTitleTemplate ?? DEFAULT_DESKTOP_GIT_PREFERENCES.pullRequestTitleTemplate, 256, true),
    pullRequestBodyTemplate: template(value.pullRequestBodyTemplate ?? DEFAULT_DESKTOP_GIT_PREFERENCES.pullRequestBodyTemplate, 12_000, false)
  }
}
/** Plain text substitution only. Values are not interpreted or expanded recursively. */
export function expandGitTextTemplate(value: string, context: GitTextTemplateContext): string {
  template(value, 12_000, false)
  return value.replace(/\{(title|branch|baseBranch|summary)\}/g, (_match, key: keyof GitTextTemplateContext) => String(context[key] ?? '').replace(/\u0000/g, '')).trim()
}
