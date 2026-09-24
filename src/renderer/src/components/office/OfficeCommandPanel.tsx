import type { BusinessLineDefinition } from '../../../../shared/business-line-types'
import type { AppSettings } from '../../../../shared/types'
import { businessLineForOfficeCreation } from '../../lib/businessLineCreation'
import type { OfficeBusinessView } from './officeReturnContext'
import type { OfficeOperationalActor } from './operationalActors'
import OfficeCommandInput, { type OfficeCommandSelectionRequest } from './OfficeCommandInput'

/** Adapt canonical selection to the command desk without changing the work view. */
export default function OfficeCommandPanel({ lines, settings, businessView, facilityLineId, agentSelected, session, actor, selectionRequest, onSelectionApplied, onOpenSession, onOpenWorkspace, onOpenActor }: {
  lines: BusinessLineDefinition[]; settings: AppSettings; businessView: OfficeBusinessView; facilityLineId?: string
  agentSelected: boolean; session?: { meta: { id: string; title: string } } | null; actor?: OfficeOperationalActor
  selectionRequest?: OfficeCommandSelectionRequest
  onSelectionApplied?(): void
  onOpenSession(id: string): void; onOpenWorkspace(id: string): void; onOpenActor(actor: OfficeOperationalActor): Promise<void>
}): React.JSX.Element {
  return <OfficeCommandInput preferSelection={agentSelected} selectionRequest={selectionRequest} onSelectionApplied={onSelectionApplied} lines={lines} zh={settings.language === 'zh'}
    defaultLineId={facilityLineId ?? businessLineForOfficeCreation(businessView, settings)}
    selectedSession={session ? { id: session.meta.id, title: session.meta.title } : undefined}
    selectedTask={actor ? { id: actor.id, title: actor.title } : undefined}
    onOpenSession={onOpenSession} onOpenWorkspace={onOpenWorkspace} onOpenTask={actor ? () => void onOpenActor(actor) : undefined} />
}
