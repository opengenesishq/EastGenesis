import { ClipboardCheck, FolderKanban, Inbox, Library, PlayCircle, Settings2 } from 'lucide-react'
import type { ExperienceMode } from '../store/experience-mode'
import type { WorkOsNavigationTarget } from './work-os-navigation'

const TARGETS: readonly WorkOsNavigationTarget[] = ['inbox', 'projects', 'runs', 'review', 'library', 'settings']

const LABELS: Record<WorkOsNavigationTarget, { zh: string; en: string }> = {
  inbox: { zh: '工作收件箱', en: 'Work Inbox' },
  projects: { zh: '项目', en: 'Projects' },
  runs: { zh: '运行', en: 'Runs' },
  review: { zh: '审查', en: 'Review' },
  library: { zh: '资源库', en: 'Library' },
  settings: { zh: '设置', en: 'Settings' }
}

interface Props {
  language: 'zh' | 'en'
  mode: ExperienceMode
  activeTarget: WorkOsNavigationTarget
  onNavigate: (target: WorkOsNavigationTarget) => void
}

export default function WorkOsPrimaryNav({ language, mode, activeTarget, onNavigate }: Props): React.JSX.Element {
  const zh = language === 'zh'
  return (
    <nav className="work-os-primary-nav" aria-label={zh ? '工作系统导航' : 'Work OS navigation'} data-work-os-primary-nav>
      {TARGETS.map((target) => {
        const label = LABELS[target][language]
        return (
          <button
            key={target}
            type="button"
            className={`sidebar-nav-item work-os-nav-item ${activeTarget === target ? 'is-active' : ''}`}
            aria-current={activeTarget === target ? 'page' : undefined}
            data-work-os-nav={target}
            data-work-os-mode={mode}
            onClick={() => onNavigate(target)}
          >
            <span className="work-os-nav-icon">{iconFor(target)}</span>
            <span>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function iconFor(target: WorkOsNavigationTarget): React.JSX.Element {
  const Icon = target === 'inbox'
    ? Inbox
    : target === 'projects'
      ? FolderKanban
      : target === 'runs'
        ? PlayCircle
        : target === 'review'
          ? ClipboardCheck
          : target === 'library'
            ? Library
            : Settings2
  return <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
}

