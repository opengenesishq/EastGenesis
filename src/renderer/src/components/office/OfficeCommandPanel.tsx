import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import type { AppSettings } from '../../../../shared/types'
import { businessLineForOfficeCreation } from '../../lib/businessLineCreation'
import type { OfficeBusinessView } from './officeReturnContext'
import type { OfficeOperationalActor } from './operationalActors'
import OfficeCommandInput from './OfficeCommandInput'

/** Adapt canonical selection to the command desk without changing the work view. */
export default function OfficeCommandPanel({ lines, settings, businessView, facilityLineId, agentSelected, session, actor, onOpenSession, onOpenActor }: {
  lines: BusinessLineDefinition[]; settings: AppSettings; businessView: OfficeBusinessView; facilityLineId?: string
  agentSelected: boolean; session?: { meta: { id: string; title: string } } | null; actor?: OfficeOperationalActor
  onOpenSession(id: string): void; onOpenActor(actor: OfficeOperationalActor): Promise<void>
}): React.JSX.Element {
  return <OfficeCommandInput preferSelection={agentSelected} lines={lines} zh={settings.language === 'zh'}
    defaultLineId={facilityLineId ?? businessLineForOfficeCreation(businessView, settings)}
    selectedSession={session ? { id: session.meta.id, title: session.meta.title } : undefined}
    selectedTask={actor ? { id: actor.id, title: actor.title } : undefined}
    onOpenSession={onOpenSession} onOpenTask={actor ? () => void onOpenActor(actor) : undefined} />
}
