import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { Activity, ChevronDown, Coins, Settings2, UserRound } from 'lucide-react'
import type { AppSettings } from '../../../shared/types'
import { useT } from '../i18n'
import { useStore } from '../store'
import { desktopProfileAvatar, normalizeDesktopPersonalization } from '../../../shared/desktop-personalization'

interface SidebarFooterProps {
  language: 'zh' | 'en'
  settings: AppSettings
  onOpenSettings: () => void
}

export default function SidebarFooter({
  language,
  settings,
  onOpenSettings
}: SidebarFooterProps): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const zh = language === 'zh'
  const profile = normalizeDesktopPersonalization(settings.desktopPersonalization).profile
  const profileName = profile.displayName || (zh ? '个人工作区' : 'Personal workspace')
  const avatar = desktopProfileAvatar(profile, language)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape) }
  }, [open])

  return (
    <div className="sidebar-footer sidebar-personal-footer" ref={root}>
      {open && <section className="sidebar-personal-menu" id="sidebar-personal-menu" aria-label={zh ? '个人工作区' : 'Personal workspace'}>
        <div className="sidebar-personal-identity"><span className="sidebar-personal-avatar" aria-hidden="true">{avatar}</span><span><strong title={profileName}>{profileName}</strong><small>{zh ? 'EastGenesis · 本地' : 'EastGenesis · Local'}</small></span></div>
        <button type="button" className="sidebar-nav-item" data-sidebar-action="local-profile" onClick={() => { setOpen(false); useStore.getState().setShowSettings(true, 'profile') }}><UserRound size={16} /><span>{zh ? '编辑本地个人资料' : 'Edit local profile'}</span></button>
        <button type="button" className="sidebar-nav-item" data-sidebar-action="usage" onClick={() => { setOpen(false); useStore.getState().setShowSettings(true, 'usage') }}><Coins size={16} /><span>{zh ? '使用情况与费用' : 'Usage & costs'}</span></button>
        <button type="button" className="sidebar-nav-item" data-sidebar-action="settings" onClick={() => { setOpen(false); onOpenSettings() }}><Settings2 size={16} /><span>{t('settings')}</span><kbd>⌘,</kbd></button>
        <button type="button" className="sidebar-nav-item" data-sidebar-action="status" onClick={() => { setOpen(false); useStore.getState().setShowSettings(true, 'status') }}><Activity size={16} /><span>{zh ? '状态' : 'Status'}</span></button>
      </section>}
      <button
        type="button"
        ref={trigger}
        className="sidebar-personal-trigger"
        data-sidebar-action="personal-menu"
        aria-label={zh ? '个人工作区菜单' : 'Personal workspace menu'}
        aria-expanded={open}
        aria-controls={open ? 'sidebar-personal-menu' : undefined}
        onClick={() => setOpen(value => !value)}
      >
        <span className="sidebar-personal-avatar" aria-hidden="true">{avatar}</span>
        <span title={profileName}>{profileName}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
    </div>
  )
}
