import type * as React from 'react'
import { useT } from '../i18n'
import { HeaderIcon } from './ChatHeaderIcons'

interface Props {
  newSessionActive: boolean
  onNewSession: () => void
}

export default function SidebarPrimaryAction(props: Props): React.JSX.Element {
  const t = useT()
  return <button type="button" className={`sidebar-nav-item sidebar-new ${props.newSessionActive ? 'is-active' : ''}`}
    aria-current={props.newSessionActive ? 'page' : undefined} onClick={props.onNewSession}>
    <HeaderIcon name="compose" /><span>{t('newSession')}</span>
  </button>
}
