import { useT } from '../../i18n'
import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import type { OfficeBusinessView } from './officeReturnContext'
import { officeViewForBusinessLine } from './operationalActors'

export default function OfficeBusinessSwitcher({ value, lines, onChange }: {
  value: OfficeBusinessView
  lines: BusinessLineDefinition[]
  onChange: (view: OfficeBusinessView) => void
}): React.JSX.Element {
  const t = useT()
  const options = [
    { id: 'all' as const, name: t('officeBusinessAll') },
    ...lines.filter((line) => line.enabled)
      .map((line) => ({ id: officeViewForBusinessLine(line.id), name: line.name }))
  ]
  return <div className="office-business-strip no-drag" role="group" aria-label={t('officeBusinessViews')}>
    {options.map((option) => <button key={option.id} type="button"
      className={`office-business-button ${value === option.id ? 'active' : ''}`}
      aria-pressed={value === option.id} data-office-business-view-option={option.id}
      onClick={() => onChange(option.id)}>{option.name}</button>)}
  </div>
}
