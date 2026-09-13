import { useState } from 'react'
import { createPortal } from 'react-dom'
import { BriefcaseBusiness, Box, Film, FolderKanban, MessageSquare, Plus } from 'lucide-react'
import type { ExperienceMode } from '../store/experience-mode'
import { getBusinessLines, resolveSelectedBusinessLine, type BusinessLineDefinition } from '../../../shared/business-line-types'
import { useStore } from '../store'
import BusinessLineManager from './business-lines/BusinessLineManager'
import { businessLineLabel } from './business-lines/business-line-labels'
import { businessLineNavigationOptionId } from './business-lines/business-line-navigation'
import './app-mode-switcher.css'
import { preloadOfficeView } from './office/loadOffice'
import { recordOfficePrewarmTrigger } from './office/officePrewarm'

interface Props {
  language: 'zh' | 'en'
  mode: ExperienceMode
  onChange: (mode: ExperienceMode) => void
  onOpenControlRoom?: () => void
}

export default function AppModeSwitcher({ language, mode, onOpenControlRoom }: Props): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const select = useStore((state) => state.selectBusinessLine)
  const setView = useStore((state) => state.setView)
  const [managerOpen, setManagerOpen] = useState(false)
  const [error, setError] = useState('')
  const options = getBusinessLines(settings).filter((line) => line.enabled)
  const selected = resolveSelectedBusinessLine({ ...settings, experienceMode: mode }).id
  const zh = language === 'zh'

  return (
    <nav className="app-mode-bar no-drag" aria-label={zh ? '业务线' : 'Business lines'} data-experience-mode-switcher>
      <div className="app-mode-switcher">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-label={businessLineLabel(option, language)}
            aria-pressed={selected === option.id}
            data-experience-mode-option={businessLineNavigationOptionId(option)}
            data-business-line-option={option.id}
            className={selected === option.id ? 'active' : ''}
            title={businessLineLabel(option, language)}
            onClick={() => { setError(''); void select(option.id).catch((cause) => setError(String(cause))) }}
          >
            <span className="app-mode-icon">{lineIcon(option)}</span>
            <span className="app-mode-label">{businessLineLabel(option, language)}</span>
          </button>
        ))}
        <button type="button" onClick={() => setManagerOpen(true)} aria-label={zh ? '管理业务线' : 'Manage business lines'} title={zh ? '管理业务线' : 'Manage business lines'} data-manage-business-lines><span className="app-mode-icon"><Plus size={14} /></span><span className="app-mode-label">{zh ? '+ 业务线' : '+ Line'}</span></button>
      </div>
      <button type="button" className="sidebar-nav-item" data-sidebar-action="control-room" data-control-room-role="global-overview"
        onPointerEnter={() => { recordOfficePrewarmTrigger('pointer-intent'); preloadOfficeView() }}
        onFocus={() => { recordOfficePrewarmTrigger('keyboard-intent'); preloadOfficeView() }}
        onClick={onOpenControlRoom ?? (() => setView('office'))} aria-label={zh ? '3D 控制室' : '3D Control Room'} title={zh ? '3D 控制室' : '3D Control Room'}><Box size={15} className="header-icon-glyph" /><span>{zh ? '3D 控制室' : '3D Control Room'}</span></button>
      {error && <small role="alert">{error}</small>}
      {managerOpen && createPortal(<BusinessLineManager onClose={() => setManagerOpen(false)} />, document.body)}
    </nav>
  )
}

function lineIcon(line: BusinessLineDefinition): React.JSX.Element {
  const Icon = line.builtinMode === 'assistant' ? MessageSquare : line.builtinMode === 'studio' ? FolderKanban : line.builtinMode === 'video' ? Film : BriefcaseBusiness
  return <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
}
