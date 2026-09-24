import { useState } from 'react'
import type { AppSettings } from '../../../../shared/types'
import { DEFAULT_DESKTOP_GIT_PREFERENCES, expandGitTextTemplate, normalizeDesktopGitPreferences, type DesktopGitPreferences } from '../../../../shared/desktop-git-preferences'

export default function GitPreferences({ draft, onChange }: { draft: AppSettings; onChange(value: DesktopGitPreferences): void }): React.JSX.Element {
  const zh = draft.language === 'zh', settings = draft.gitPreferences ?? DEFAULT_DESKTOP_GIT_PREFERENCES
  const [value, setValue] = useState<DesktopGitPreferences>(() => ({ ...settings }))
  const [notice, setNotice] = useState('')
  let error = ''
  try { normalizeDesktopGitPreferences(value) } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
  const edit = (key: keyof DesktopGitPreferences, text: string): void => { setNotice(''); setValue(current => ({ ...current, [key]: text })) }
  const examples = { title: zh ? '修复资料预览' : 'Fix source preview', branch: `${value.branchPrefix}/example`, baseBranch: 'main', summary: zh ? '修复预览入口，并保留当前任务。' : 'Fix the preview entry while preserving the current task.' }
  return <section data-git-preferences>
    <p className="desktop-preference-intro">{zh ? '分支前缀用于新建 Worktree。提交和 PR 文案会先填入可编辑草稿，提交时使用你确认的内容。' : 'The prefix applies to new worktrees. Commit and PR templates fill editable drafts before you submit them.'}</p>
    <label className="field-label" htmlFor="git-branch-prefix">{zh ? '新分支前缀' : 'New branch prefix'}</label>
    <input id="git-branch-prefix" className="input input-block" maxLength={80} value={value.branchPrefix} onChange={event => edit('branchPrefix', event.target.value)} />
    <p className="settings-hint">{zh ? '例如 caogen → caogen/任务标识；现有分支保持原名称。' : 'For example: caogen → caogen/task-id. Existing branches keep their names.'}</p>
    <p className="settings-hint">{zh ? '文案字段：{title} 任务标题、{branch} 当前分支、{baseBranch} 目标分支、{summary} 变更摘要。只替换文本。' : 'Template fields: {title}, {branch}, {baseBranch}, {summary}. Plain text substitution only.'}</p>
    {([
      ['commitTemplate', zh ? '提交文案模板（可留空）' : 'Commit template (optional)', 2_000, 3],
      ['pullRequestTitleTemplate', zh ? 'PR 标题模板' : 'PR title template', 256, 1],
      ['pullRequestBodyTemplate', zh ? 'PR 正文模板' : 'PR body template', 12_000, 6]
    ] as const).map(([key, label, limit, rows]) => <div key={key}>
      <label className="field-label" htmlFor={`git-${key}`}>{label}</label>
      <textarea id={`git-${key}`} className="input input-block" rows={rows} maxLength={limit} value={value[key]} onChange={event => edit(key, event.target.value)} />
    </div>)}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {!error && <details><summary>{zh ? '查看文案示例' : 'Preview example text'}</summary><pre className="settings-hint">{expandGitTextTemplate(value.pullRequestTitleTemplate, examples)}{'\n\n'}{expandGitTextTemplate(value.pullRequestBodyTemplate, examples)}</pre></details>}
    <div className="personalization-actions"><button className="btn btn-primary" disabled={!!error} onClick={() => { onChange(normalizeDesktopGitPreferences(value)); setNotice(zh ? '已加入设置草稿，保存设置后生效。' : 'Added to the draft. Save settings to apply.')}}>{zh ? '应用到设置草稿' : 'Apply to settings draft'}</button>
      <button className="btn btn-ghost" onClick={() => { const defaults = { ...DEFAULT_DESKTOP_GIT_PREFERENCES }; setValue(defaults); onChange(defaults); setNotice(zh ? '默认值已加入草稿，请保存设置。' : 'Defaults added to the draft. Save settings to apply.') }}>{zh ? '恢复默认' : 'Reset defaults'}</button></div>
    {notice && <p role="status" className="settings-hint">{notice}</p>}
  </section>
}
