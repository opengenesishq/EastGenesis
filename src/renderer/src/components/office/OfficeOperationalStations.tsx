import { Suspense } from 'react'
import WorkstationPro from './kit/ming-characters/MingWorkstation'
import type { OfficeOperationalActor } from './operationalActors'

export default function OfficeOperationalStations({ actors, positions, selectedId, onSelect, onOpen, interactiveIds, reducedMotion = false }: {
  actors: OfficeOperationalActor[]
  positions: Array<[number, number, number]>
  selectedId: string | null
  onSelect: (id: string) => void
  onOpen: (actor: OfficeOperationalActor) => void
  reducedMotion?: boolean
  interactiveIds?: string[]
}): React.JSX.Element {
  return <>{actors.map((actor, index) => <Suspense key={actor.id} fallback={null}>
    <group name="office-operational-actor" userData={{ officeActorId: actor.id, sourceKind: actor.kind,
      sourceId: actor.sourceId, runId: actor.runId, businessLineId: actor.businessLineId, status: actor.status }}>
      <WorkstationPro
        sessionId={actor.id} position={positions[index]} active={selectedId === actor.id} reducedMotion={reducedMotion}
        activeDetail="compact" activity={actor.activity} title={actor.title} interactive={!interactiveIds || interactiveIds.includes(actor.id)}
        awaitingText={actor.status === 'waiting_reconciliation' ? '等待对账' : actor.status === 'blocked' ? '任务受阻' : '等待审批'}
        costUsd={actor.actualUsd ?? 0} costKnown={actor.actualUsd !== undefined} brandName={actor.providerName} modelName={actor.model}
        watercolorRole={actor.kind === 'media' ? 'designer' : 'operations'}
        onSelect={() => onSelect(actor.id)} onOpen={() => onOpen(actor)}
      />
    </group>
  </Suspense>)}</>
}
