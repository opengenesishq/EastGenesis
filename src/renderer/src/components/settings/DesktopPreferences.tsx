import type { ReactNode } from 'react'
import type { AppSettings } from '../../../../shared/types'
import { useT } from '../../i18n'
import DesktopShortcutSettings, { DesktopFontSettings } from './DesktopShortcutSettings'
import { formatShortcut, shortcutFor } from '../../../../shared/desktop-shortcuts'
import { normalizeSuggestedPrompts } from '../../../../shared/suggested-prompt-settings'
import { desktopShortcutPlatform } from '../../desktop-keyboard'
import DesktopThemeSettings from './DesktopThemeSettings'
import SessionFollowUpSelect from '../composer/SessionFollowUpSelect'
import { normalizeSessionFollowUpBehavior } from '../../../../shared/session-follow-up'

export function PreferenceRow({ title, description, children }: { title: string; description?: string; children: ReactNode }): React.JSX.Element {
  return <div className="desktop-preference-row">
    <div className="desktop-preference-label"><span>{title}</span>{description && <p>{description}</p>}</div>
    <div className="desktop-preference-control">{children}</div>
  </div>
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <button type="button" className="desktop-preference-toggle" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>
}

export default function DesktopPreferences({ draft, onChange, appearance = false }: {
  draft: AppSettings; onChange(patch: Partial<AppSettings>): void; appearance?: boolean
}): React.JSX.Element {
  const t = useT()
  const zh = draft.language === 'zh'
  const sendKey = shortcutFor('sendMessage', draft.desktopShortcuts)
  const commonSendKey = sendKey === 'Enter' || sendKey === 'CommandOrControl+Enter'
  const prompts = normalizeSuggestedPrompts(draft.suggestedPrompts)
  if (appearance) return <>
    <h2 className="desktop-preference-heading">{zh ? '外观' : 'Appearance'}</h2>
    <div className="desktop-preference-card">
      <PreferenceRow title={t('theme')} description={zh ? '选择浅色、深色或跟随系统。' : 'Choose light, dark, or match your system.'}>
        <select className="select" aria-label={t('theme')} value={draft.theme} onChange={event => onChange({ theme: event.target.value as AppSettings['theme'] })}>
          <option value="system">{t('themeSystem')}</option><option value="light">{t('themeLight')}</option><option value="dark">{t('themeDark')}</option>
        </select>
      </PreferenceRow>
      <PreferenceRow title={t('layoutChatScale')}>
        <select className="select" aria-label={t('layoutChatScale')} value={draft.layout.chatScale} onChange={event => onChange({ layout: { ...draft.layout, chatScale: Number(event.target.value) } })}>
          {[0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
        </select>
      </PreferenceRow>
      <PreferenceRow title={t('layoutChatDensity')}>
        <select className="select" aria-label={t('layoutChatDensity')} value={draft.layout.chatDensity} onChange={event => onChange({ layout: { ...draft.layout, chatDensity: event.target.value as AppSettings['layout']['chatDensity'] } })}>
          <option value="comfortable">{t('chatDensityComfortable')}</option><option value="compact">{t('chatDensityCompact')}</option>
        </select>
      </PreferenceRow>
      <PreferenceRow title={t('layoutSidebarWidth')}><input aria-label={t('layoutSidebarWidth')} type="range" min={220} max={420} step={4} value={draft.layout.sidebarWidth} onChange={event => onChange({ layout: { ...draft.layout, sidebarWidth: Number(event.target.value) } })} /><span>{draft.layout.sidebarWidth}px</span></PreferenceRow>
      <PreferenceRow title={t('layoutToolPanelWidth')}><input aria-label={t('layoutToolPanelWidth')} type="range" min={320} max={720} step={8} value={draft.layout.workbenchSideWidth} onChange={event => onChange({ layout: { ...draft.layout, workbenchSideWidth: Number(event.target.value) } })} /><span>{draft.layout.workbenchSideWidth}px</span></PreferenceRow>
      <PreferenceRow title={zh ? '字体' : 'Fonts'} description={zh ? '界面、代码编辑器和终端使用的本机字体。' : 'Local fonts used by the interface, editor, and terminal.'}>
        <DesktopFontSettings value={draft.desktopFonts} language={draft.language} onChange={desktopFonts => onChange({ desktopFonts })} />
      </PreferenceRow>
    </div>
    <DesktopThemeSettings value={draft.desktopPersonalization} language={draft.language} onChange={desktopPersonalization => onChange({ desktopPersonalization })} />
    <h2 className="desktop-preference-heading">{zh ? '快捷键' : 'Shortcuts'}</h2>
    <div className="desktop-preference-card"><DesktopShortcutSettings value={draft.desktopShortcuts} language={draft.language} onChange={desktopShortcuts => onChange({ desktopShortcuts })} /></div>
  </>
  return <>
    <h2 className="desktop-preference-heading">{zh ? '权限' : 'Permissions'}</h2>
    <div className="desktop-preference-card">
      <PreferenceRow title={zh ? '默认任务权限' : 'Default task permissions'} description={zh ? '选择新任务以查看、计划或执行开始。文件、命令和外部操作仍遵守各自的授权。' : 'Start new tasks in view, plan, or execute mode. Files, commands, and external actions follow their authorization rules.'}>
        <select className="select" aria-label={zh ? '默认任务权限' : 'Default task permissions'} value={draft.defaultTaskStrategy} onChange={event => onChange({ defaultTaskStrategy: event.target.value as AppSettings['defaultTaskStrategy'] })}>
          <option value="view">{t('taskStrategyView')}</option><option value="plan">{t('taskStrategyPlan')}</option><option value="execute">{t('taskStrategyExecute')}</option>
        </select>
      </PreferenceRow>
    </div>
    <h2 className="desktop-preference-heading">{zh ? '常规' : 'General'}</h2>
    <div className="desktop-preference-card">
      <PreferenceRow title={zh ? '发送消息' : 'Send messages'} description={zh ? '同时应用于新任务和当前对话。Shift+Enter 始终换行；其他组合可在快捷键中设置。' : 'Applies to new tasks and conversations. Shift+Enter adds a line; other bindings can be configured in Shortcuts.'}>
        <select className="select" aria-label={zh ? '发送消息' : 'Send messages'} value={commonSendKey ? sendKey! : 'custom'} onChange={event => onChange({ desktopShortcuts: { ...draft.desktopShortcuts, sendMessage: event.target.value } })}>
          <option value="Enter">Enter</option>
          <option value="CommandOrControl+Enter">{formatShortcut('CommandOrControl+Enter', desktopShortcutPlatform())}</option>
          {!commonSendKey && <option value="custom" disabled>{sendKey ? formatShortcut(sendKey, desktopShortcutPlatform()) : zh ? '已禁用' : 'Disabled'}</option>}
        </select>
      </PreferenceRow>
      <PreferenceRow title={t('language')} description={zh ? '应用界面语言' : 'Application display language'}>
        <select className="select" aria-label={t('language')} value={draft.language} onChange={event => onChange({ language: event.target.value as AppSettings['language'] })}><option value="zh">简体中文</option><option value="en">English</option></select>
      </PreferenceRow>
      <PreferenceRow title={zh ? '运行中追问' : 'Follow-up behavior'} description={zh ? '补充保留在原任务。暂停、重启或结果待核对时停止自动继续；目标和交付要求修订仍需确认。' : 'Additions stay in the original task. Pausing, restart, or unknown results stop automatic continuation. Goal and requirement revisions still need review.'}>
        <SessionFollowUpSelect value={normalizeSessionFollowUpBehavior(draft.followUpBehavior)} zh={zh} onChange={followUpBehavior => onChange({ followUpBehavior })} />
      </PreferenceRow>

      <PreferenceRow title={t('notificationsEnabled')} description={t('notificationsHint')}><Toggle label={t('notificationsEnabled')} checked={draft.notificationsEnabled} onChange={notificationsEnabled => onChange({ notificationsEnabled })} /></PreferenceRow>
      <PreferenceRow title={t('preventDisplaySleep')} description={t('preventDisplaySleepHint')}><Toggle label={t('preventDisplaySleep')} checked={draft.preventDisplaySleep} onChange={preventDisplaySleep => onChange({ preventDisplaySleep })} /></PreferenceRow>
      <PreferenceRow title={zh ? '自动积累工作方法' : 'Learn reusable skills'} description={zh ? '完成任务后整理并验证可复用的 Skill，供后续同类工作使用。' : 'After successful tasks, extract and validate reusable skills for related work.'}><Toggle label={zh ? '自动积累工作方法' : 'Learn reusable skills'} checked={draft.autoSkillLearningEnabled} onChange={autoSkillLearningEnabled => onChange({ autoSkillLearningEnabled })} /></PreferenceRow>
    </div>
    <h2 className="desktop-preference-heading">{zh ? '建议提示' : 'Suggested prompts'}</h2>
    <div className="desktop-preference-card">
      <PreferenceRow title={zh ? '新任务示例' : 'New task examples'} description={zh ? '在新任务输入框下显示可展开的示例。' : 'Show expandable examples below the new task composer.'}>
        <Toggle label={zh ? '新任务示例' : 'New task examples'} checked={prompts.examples} onChange={examples => onChange({ suggestedPrompts: { ...prompts, examples } })} />
      </PreferenceRow>
      <PreferenceRow title={zh ? '上下文建议' : 'Context suggestions'} description={zh ? '允许从任务菜单查看基于当前项目的工作建议，点击后才加载。' : 'Enable on-demand project suggestions in the task menu.'}>
        <Toggle label={zh ? '上下文建议' : 'Context suggestions'} checked={prompts.contextual} onChange={contextual => onChange({ suggestedPrompts: { ...prompts, contextual } })} />
      </PreferenceRow>
    </div>
  </>
}
