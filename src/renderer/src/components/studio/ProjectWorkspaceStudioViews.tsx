import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type UIEvent } from 'react'
import type { AcceptanceResult, Goal, GoalPatch, GoalRiskLevel, WorkItem, WorkItemOwner, WorkItemStatus } from '../../../../shared/types'
import { GoalEditForm } from './ProjectWorkspaceStudioForms'
import { WorkItemTransferForm } from './WorkItemTransferForm'
import {
  acceptancePresentation,
  DEFAULT_WORK_ITEM_FILTERS,
  formatDate,
  GOAL_RISK_OPTIONS,
  GOAL_STATUS_LABELS,
  GOAL_TRANSITIONS,
  TEXT,
  type GoalControlAction,
  type StudioView,
  type WorkItemControlAction,
  type WorkItemFilters,
  projectWorkItems,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  WORK_ITEM_STATUS_LABELS,
  workItemTypeLabel
} from './projectWorkspaceStudioModel'

const WORK_ITEM_LIST_ROW_HEIGHT = 176
const WORK_ITEM_BOARD_CARD_HEIGHT = 362
const WORK_ITEM_VIRTUAL_MAX_HEIGHT = 604
const WORK_ITEM_VIRTUAL_OVERSCAN = 3

export function GoalsView({
  goals,
  onControl,
  onCreate,
  onUpdate
}: {
  goals: Goal[]
  onControl: (goal: Goal, action: GoalControlAction) => Promise<void>
  onCreate: () => void
  onUpdate: (goal: Goal, patch: GoalPatch) => Promise<void>
}): React.JSX.Element {
  const titleId = useId()
  return (
    <section className="pws-section" aria-labelledby={titleId}>
      <SectionHeader id={titleId} title={TEXT.goals} count={goals.length} action={TEXT.createGoal} onAction={onCreate} />
      {goals.length === 0 ? <EmptyState message={TEXT.noGoals} action={TEXT.createGoal} onAction={onCreate} /> : (
        <div className="pws-goal-list" role="list">
          {goals.map((goal) => <GoalRow key={goal.id} goal={goal} onControl={onControl} onUpdate={onUpdate} />)}
        </div>
      )}
    </section>
  )
}

export function WorkItemsView({
  goals,
  items,
  onCreate,
  onControl,
  onAcceptance,
  onReorder,
  onTransfer,
  onViewChange,
  projectId,
  view,
  requestedWorkItemId
}: {
  goals: Goal[]
  items: WorkItem[]
  onCreate: () => void
  onControl?: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  onAcceptance?: (item: WorkItem, result: AcceptanceResult) => Promise<void>
  onReorder?: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  onTransfer?: (item: WorkItem, target: WorkItemOwner, reason: string, requestId: string) => Promise<void>
  onViewChange: (view: StudioView) => void
  projectId: string
  view: StudioView
  requestedWorkItemId?: string
}): React.JSX.Element {
  const titleId = useId()
  const [filters, setFilters] = useState<WorkItemFilters>(() => readStoredWorkItemFilters(projectId))
  const [transferItemId, setTransferItemId] = useState('')
  const goalNames = useMemo(() => new Map(goals.map((goal) => [goal.id, goal.title])), [goals])
  const visibleItems = useMemo(() => projectWorkItems(items, filters), [filters, items])
  const transferItem = items.find((item) => item.id === transferItemId)
  useEffect(() => {
    try {
      window.localStorage.setItem(workItemFilterStorageKey(projectId), JSON.stringify(filters))
    } catch {
      // Preference persistence is best effort; canonical WorkItem data remains durable in the main process.
    }
  }, [filters, projectId])
  useEffect(() => {
    if (!requestedWorkItemId || !items.some((item) => item.id === requestedWorkItemId)) return
    // An explicit Control Room handoff must win over a remembered local
    // filter, otherwise a canonical waiting/blocked WorkItem can remain
    // present yet impossible to locate in the 2D board.
    setFilters(DEFAULT_WORK_ITEM_FILTERS)
  }, [items, requestedWorkItemId])
  useLayoutEffect(() => {
    if (!requestedWorkItemId) return
    const target = document.querySelector<HTMLElement>(`[data-work-item-id="${CSS.escape(requestedWorkItemId)}"]`)
    if (!target) return
    target.dataset.workItemNavigationTarget = 'true'
    target.tabIndex = -1
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
    const timer = window.setTimeout(() => {
      if (target.isConnected) delete target.dataset.workItemNavigationTarget
    }, 2_000)
    return () => window.clearTimeout(timer)
  }, [requestedWorkItemId, visibleItems, view])
  return (
    <section className="pws-section pws-work-items" aria-labelledby={titleId}>
      <div className="pws-section-header">
        <div className="pws-section-title">
          <h2 id={titleId}>{TEXT.workItems}</h2>
          <span aria-label={TEXT.filteredItemCount(visibleItems.length, items.length)}>{visibleItems.length} / {items.length}</span>
        </div>
        <div className="pws-section-actions">
          <StudioViewToggle value={view} onChange={onViewChange} />
          <button type="button" className="btn btn-primary btn-sm" onClick={onCreate}>{TEXT.createWorkItem}</button>
        </div>
      </div>
      <WorkItemFilterBar goals={goals} filters={filters} onChange={setFilters} />
      {transferItem && onTransfer && (
        <WorkItemTransferForm
          key={`${transferItem.id}:${transferItem.revision}`}
          item={transferItem}
          onCancel={() => setTransferItemId('')}
          onSubmit={onTransfer}
        />
      )}
      {items.length === 0 ? <EmptyState message={TEXT.noWorkItems} action={TEXT.createWorkItem} onAction={onCreate} /> : (
        visibleItems.length === 0
          ? <div className="pws-filter-empty" data-work-item-filter-empty>{TEXT.noMatchingWorkItems}</div>
          : view === 'list'
            ? <WorkItemList items={visibleItems} goalNames={goalNames} targetItemId={requestedWorkItemId} onAcceptance={onAcceptance} onControl={onControl} onReorder={onReorder} onTransferRequest={onTransfer ? setTransferItemId : undefined} />
            : <WorkItemBoard items={visibleItems} allItems={items} goalNames={goalNames} targetItemId={requestedWorkItemId} onAcceptance={onAcceptance} onControl={onControl} onReorder={onReorder} onTransferRequest={onTransfer ? setTransferItemId : undefined} />
      )}
    </section>
  )
}

function WorkItemFilterBar({
  filters,
  goals,
  onChange
}: {
  filters: WorkItemFilters
  goals: Goal[]
  onChange: (filters: WorkItemFilters) => void
}): React.JSX.Element {
  const active = filters.query !== '' || filters.status !== 'all' || filters.goalId !== 'all' || filters.owner !== 'all'
  return (
    <div className="pws-work-item-filters" role="search" aria-label={TEXT.filterWorkItems} data-work-item-filters>
      <input
        type="search"
        value={filters.query}
        placeholder={TEXT.searchWorkItems}
        aria-label={TEXT.searchWorkItems}
        data-work-item-filter="query"
        onChange={(event) => onChange({ ...filters, query: event.target.value })}
      />
      <select
        value={filters.status}
        aria-label={TEXT.status}
        data-work-item-filter="status"
        onChange={(event) => onChange({ ...filters, status: event.target.value as WorkItemFilters['status'] })}
      >
        <option value="all">{TEXT.allStatuses}</option>
        {WORK_ITEM_STATUSES.map((status) => <option key={status} value={status}>{WORK_ITEM_STATUS_LABELS[status]}</option>)}
      </select>
      <select
        value={filters.goalId}
        aria-label={TEXT.goal}
        data-work-item-filter="goal"
        onChange={(event) => onChange({ ...filters, goalId: event.target.value })}
      >
        <option value="all">{TEXT.allGoals}</option>
        <option value="none">{TEXT.noLinkedGoal}</option>
        {goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
      </select>
      <select
        value={filters.owner}
        aria-label={TEXT.owner}
        data-work-item-filter="owner"
        onChange={(event) => onChange({ ...filters, owner: event.target.value as WorkItemFilters['owner'] })}
      >
        <option value="all">{TEXT.allOwners}</option>
        <option value="unassigned">{TEXT.unassignedOwner}</option>
        <option value="human">{TEXT.humanOwner}</option>
        <option value="digital_worker">{TEXT.digitalWorkerOwner}</option>
      </select>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={!active}
        data-work-item-filter="clear"
        onClick={() => onChange(DEFAULT_WORK_ITEM_FILTERS)}
      >
        {TEXT.clearFilters}
      </button>
    </div>
  )
}

function GoalRow({
  goal,
  onControl,
  onUpdate
}: {
  goal: Goal
  onControl: (goal: Goal, action: GoalControlAction) => Promise<void>
  onUpdate: (goal: Goal, patch: GoalPatch) => Promise<void>
}): React.JSX.Element {
  const acceptance = acceptancePresentation(goal.acceptance.length, goal.acceptanceResult)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const transitions = GOAL_TRANSITIONS[goal.status]
  const canArchive = goal.status === 'completed' || goal.status === 'failed' || goal.status === 'cancelled'
  const runControl = async (action: GoalControlAction): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onControl(goal, action)
      if (action.kind === 'archive' || action.kind === 'restore') setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const update = async (patch: GoalPatch): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onUpdate(goal, patch)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="pws-goal-row"
      role="listitem"
      data-goal-id={goal.id}
      data-goal-revision={goal.revision}
      data-status={goal.status}
    >
      <summary aria-label={`${TEXT.goalDetails}: ${goal.title}`}>
        <span className="pws-row-title">
          <strong>{goal.title}</strong>
          <span>{goal.objective}</span>
        </span>
        <span className="pws-row-badges">
          <StatusBadge status={goal.status} label={GOAL_STATUS_LABELS[goal.status]} />
          <span className={`pws-risk pws-risk-${goal.riskLevel}`}>{riskLabel(goal.riskLevel)}</span>
          <AcceptanceBadge status={acceptance.status} label={acceptance.label} />
        </span>
      </summary>
      <div className="pws-goal-contract">
        <ContractBlock label={TEXT.objective} value={goal.objective} />
        {goal.background && <ContractBlock label={TEXT.background} value={goal.background} />}
        <ContractList label={TEXT.constraints} values={goal.constraints} />
        <ContractList label={TEXT.successCriteria} values={goal.successCriteria} />
        <ContractList label={TEXT.acceptanceCriteria} values={goal.acceptance.map((item) => item.criterion)} />
        <ContractList label={TEXT.forbiddenActions} values={goal.forbiddenActions} />
        <ContractBlock label={TEXT.dueDate} value={formatDate(goal.dueAt)} />
        {goal.budget && <ContractBlock label={TEXT.budgetAmount} value={budgetLabel(goal.budget)} />}
      </div>
      <div className="pws-goal-controls" aria-label={TEXT.goalControls} data-goal-controls={goal.id}>
        <div className="pws-goal-control-actions">
          {goal.status !== 'archived' && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={busy}
              aria-pressed={editing}
              data-goal-action="edit"
              onClick={() => {
                setError('')
                setEditing((current) => !current)
              }}
            >
              {TEXT.editGoal}
            </button>
          )}
          {transitions.map((status) => (
            <button
              key={status}
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={busy}
              data-goal-transition={status}
              onClick={() => void runControl({ kind: 'transition', status })}
            >
              {TEXT.transitionTo(GOAL_STATUS_LABELS[status])}
            </button>
          ))}
          {canArchive && (
            <button type="button" className="btn btn-ghost btn-xs" disabled={busy} data-goal-action="archive" onClick={() => void runControl({ kind: 'archive' })}>
              {TEXT.archiveGoal}
            </button>
          )}
          {goal.status === 'archived' && (
            <button type="button" className="btn btn-ghost btn-xs" disabled={busy} data-goal-action="restore" onClick={() => void runControl({ kind: 'restore' })}>
              {TEXT.restoreGoal}
            </button>
          )}
        </div>
        {error && <span className="pws-goal-control-error" role="alert" data-goal-control-error>{TEXT.goalControlFailed}: {error}</span>}
      </div>
      {editing && goal.status !== 'archived' && (
        <div className="pws-goal-edit">
          <GoalEditForm busy={busy} goal={goal} onCancel={() => setEditing(false)} onSubmit={update} />
        </div>
      )}
    </details>
  )
}

function WorkItemList({
  items,
  goalNames,
  targetItemId,
  onControl,
  onAcceptance,
  onReorder,
  onTransferRequest
}: {
  items: WorkItem[]
  goalNames: Map<string, string>
  targetItemId?: string
  onControl?: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  onAcceptance?: (item: WorkItem, result: AcceptanceResult) => Promise<void>
  onReorder?: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  onTransferRequest?: (workItemId: string) => void
}): React.JSX.Element {
  return (
    <div className="pws-table" role="table" aria-label={TEXT.workItems} aria-rowcount={items.length + 1} tabIndex={0} data-work-item-list data-horizontal-scroll-region>
      <div className="pws-table-content">
        <div className="pws-table-row pws-table-head" role="row">
          <span role="columnheader">{TEXT.workItemTitle}</span><span role="columnheader">{TEXT.goal}</span><span role="columnheader">{TEXT.type}</span><span role="columnheader">{TEXT.owner}</span><span role="columnheader">{TEXT.due}</span><span role="columnheader">{TEXT.status}</span><span role="columnheader">{TEXT.acceptance}</span><span role="columnheader">{TEXT.workItemControls}</span>
        </div>
        <VirtualWorkItemStack
          items={items}
          rowHeight={WORK_ITEM_LIST_ROW_HEIGHT}
          className="pws-table-scroll"
          dataSurface="list"
          targetItemId={targetItemId}
          renderItem={(item, index) => {
            const acceptance = acceptancePresentation(item.acceptanceSpec.length, item.acceptance)
            return (
              <div
                className="pws-table-row pws-table-body-row"
                role="row"
                data-work-item-id={item.id}
                data-work-item-navigation-target={targetItemId === item.id ? 'true' : undefined}
                data-status={item.status}
                data-work-item-revision={item.revision}
                data-board-order={item.boardOrder ?? ''}
                data-goal-id={item.goalId ?? ''}
                data-owner-id={item.owner?.id ?? ''}
                data-priority={item.priority}
              >
                <span role="cell"><strong>{item.title}</strong>{item.description && <span className="pws-table-note">{item.description}</span>}</span>
                <span role="cell">{item.goalId ? goalNames.get(item.goalId) ?? TEXT.noLinkedGoal : TEXT.noLinkedGoal}</span>
                <span role="cell">{workItemTypeLabel(item.type)}</span>
                <span role="cell">{item.owner?.displayName ?? item.owner?.id ?? TEXT.untitledOwner}</span>
                <span role="cell">{formatDate(item.dueAt)}</span>
                <span role="cell"><StatusBadge status={item.status} label={WORK_ITEM_STATUS_LABELS[item.status]} /></span>
                <span role="cell"><AcceptanceBadge status={acceptance.status} label={acceptance.label} /></span>
                <span role="cell" className="pws-table-actions">
                  {onReorder && <WorkItemOrderControls item={item} previous={items[index - 1]} next={items[index + 1]} onReorder={onReorder} />}
                  {onControl && <WorkItemControls item={item} onAction={onControl} onTransfer={onTransferRequest ? () => onTransferRequest(item.id) : undefined} onAcceptance={onAcceptance} />}
                </span>
              </div>
            )
          }}
        />
      </div>
    </div>
  )
}

function WorkItemBoard({
  allItems,
  items,
  goalNames,
  targetItemId,
  onControl,
  onAcceptance,
  onReorder,
  onTransferRequest
}: {
  allItems: WorkItem[]
  items: WorkItem[]
  goalNames: Map<string, string>
  targetItemId?: string
  onControl?: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  onAcceptance?: (item: WorkItem, result: AcceptanceResult) => Promise<void>
  onReorder?: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  onTransferRequest?: (workItemId: string) => void
}): React.JSX.Element {
  const baseId = useId()
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] = useState<WorkItemStatus | null>(null)
  const [dragError, setDragError] = useState('')
  const itemById = useMemo(() => new Map(allItems.map((item) => [item.id, item])), [allItems])
  const handleDrop = async (status: WorkItemStatus, event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault()
    const itemId = event.dataTransfer.getData('text/plain') || draggedItemId
    const item = itemId ? itemById.get(itemId) : undefined
    setDraggedItemId(null)
    setDragOverStatus(null)
    if (!item || !onControl || item.status === status || !WORK_ITEM_TRANSITIONS[item.status].includes(status)) return
    setDragError('')
    try {
      await onControl(item, { kind: 'transition', status })
    } catch (cause) {
      setDragError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <div className="pws-board" aria-label={TEXT.board}>
      {dragError && <div className="pws-board-drag-error" role="alert">{TEXT.controlFailed}: {dragError}</div>}
      {WORK_ITEM_STATUSES.map((status) => {
        const statusItems = items.filter((item) => item.status === status)
        const headingId = `${baseId}-${status}`
        return (
          <section
            key={status}
            className={`pws-board-column${dragOverStatus === status ? ' pws-board-column-drag-over' : ''}`}
            aria-labelledby={headingId}
            onDragOver={(event) => {
              const dragged = draggedItemId ? itemById.get(draggedItemId) : undefined
              if (!dragged || !WORK_ITEM_TRANSITIONS[dragged.status].includes(status)) return
              event.preventDefault()
              setDragOverStatus(status)
            }}
            onDragLeave={() => setDragOverStatus((current) => current === status ? null : current)}
            onDrop={(event) => { void handleDrop(status, event) }}
            data-board-drop-status={status}
          >
            <header><h3 id={headingId}>{WORK_ITEM_STATUS_LABELS[status]}</h3><span>{statusItems.length}</span></header>
            {statusItems.length === 0 ? <div className="pws-board-empty" data-board-status-empty={status} /> : (
              <VirtualWorkItemStack
                items={statusItems}
                rowHeight={WORK_ITEM_BOARD_CARD_HEIGHT}
                className="pws-board-items"
                dataSurface={`board-${status}`}
                targetItemId={targetItemId}
                renderItem={(item, index) => (
                  <WorkItemBoardCard
                    item={item}
                    targetItemId={targetItemId}
                    dependencyItems={item.dependencyIds.map((id) => itemById.get(id)).filter((candidate): candidate is WorkItem => Boolean(candidate))}
                    goalName={item.goalId ? goalNames.get(item.goalId) : undefined}
                    onControl={onControl}
                    onAcceptance={onAcceptance}
                    onReorder={onReorder}
                    onTransfer={onTransferRequest ? () => onTransferRequest(item.id) : undefined}
                    previous={statusItems[index - 1]}
                    next={statusItems[index + 1]}
                    draggable={Boolean(onControl)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', item.id)
                      setDragError('')
                      setDraggedItemId(item.id)
                    }}
                    onDragEnd={() => { setDraggedItemId(null); setDragOverStatus(null) }}
                  />
                )}
              />
            )}
          </section>
        )
      })}
    </div>
  )
}

function WorkItemBoardCard({
  dependencyItems,
  draggable,
  item,
  targetItemId,
  goalName,
  next,
  onControl,
  onAcceptance,
  onReorder,
  onTransfer,
  previous,
  onDragStart,
  onDragEnd
}: {
  item: WorkItem
  targetItemId?: string
  dependencyItems: WorkItem[]
  draggable: boolean
  goalName?: string
  next?: WorkItem
  onControl?: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  onAcceptance?: (item: WorkItem, result: AcceptanceResult) => Promise<void>
  onReorder?: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  onTransfer?: () => void
  previous?: WorkItem
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}): React.JSX.Element {
  const acceptance = acceptancePresentation(item.acceptanceSpec.length, item.acceptance)
  const incompleteDependencies = item.dependencyIds.filter((id) => item.dependencyIds.length > 0 && dependencyItems.find((dependency) => dependency.id === id)?.status !== 'done')
  const missingDependencies = item.dependencyIds.filter((id) => !dependencyItems.some((dependency) => dependency.id === id))
  return (
    <article
      className="pws-board-item"
      role="listitem"
      data-work-item-id={item.id}
      data-work-item-navigation-target={targetItemId === item.id ? 'true' : undefined}
      data-status={item.status}
      data-work-item-revision={item.revision}
      data-board-order={item.boardOrder ?? ''}
      data-goal-id={item.goalId ?? ''}
      data-owner-id={item.owner?.id ?? ''}
      data-priority={item.priority}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="pws-board-item-head"><strong>{item.title}</strong><span>{workItemTypeLabel(item.type)}</span></div>
      {item.description && <p>{item.description}</p>}
      <div className="pws-board-item-meta">
        <span>{goalName ?? TEXT.noLinkedGoal}</span>
        <span>{item.owner?.displayName ?? item.owner?.id ?? TEXT.untitledOwner}</span>
        <span>{formatDate(item.dueAt)}</span>
      </div>
      {item.dependencyIds.length > 0 && (
        <div className={`pws-board-dependencies${incompleteDependencies.length > 0 ? ' pws-board-dependencies-blocked' : ''}`} title={missingDependencies.length > 0 ? TEXT.dependencyMissingTitle : undefined}>
          {incompleteDependencies.length === 0 ? TEXT.dependenciesSatisfied : TEXT.dependenciesIncomplete(incompleteDependencies.length, item.dependencyIds.length)}
          {missingDependencies.length > 0 ? ` · ${TEXT.dependenciesMissing(missingDependencies.length)}` : ''}
        </div>
      )}
      <div className="pws-row-badges">
        <StatusBadge status={item.status} label={WORK_ITEM_STATUS_LABELS[item.status]} />
        <AcceptanceBadge status={acceptance.status} label={acceptance.label} />
      </div>
      {onReorder && <WorkItemOrderControls item={item} previous={previous} next={next} onReorder={onReorder} />}
      {onControl && <WorkItemControls item={item} onAction={onControl} onTransfer={onTransfer} onAcceptance={onAcceptance} />}
    </article>
  )
}

function WorkItemOrderControls({
  item,
  next,
  onReorder,
  previous
}: {
  item: WorkItem
  next?: WorkItem
  onReorder: (item: WorkItem, targetId: string, placement: 'before' | 'after') => Promise<void>
  previous?: WorkItem
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reorder = async (target: WorkItem | undefined, placement: 'before' | 'after'): Promise<void> => {
    if (!target) return
    setBusy(true)
    setError('')
    try {
      await onReorder(item, target.id, placement)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-work-item-order" data-work-item-order-controls={item.id}>
      <button
        type="button"
        className="btn btn-ghost btn-xs pws-order-button"
        disabled={busy || !previous}
        aria-label={TEXT.moveWorkItemUp}
        title={TEXT.moveWorkItemUp}
        data-work-item-reorder="up"
        onClick={() => void reorder(previous, 'before')}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-xs pws-order-button"
        disabled={busy || !next}
        aria-label={TEXT.moveWorkItemDown}
        title={TEXT.moveWorkItemDown}
        data-work-item-reorder="down"
        onClick={() => void reorder(next, 'after')}
      >
        <span aria-hidden="true">↓</span>
      </button>
      {error && <span className="pws-work-item-control-error" role="alert">{TEXT.reorderFailed}: {error}</span>}
    </div>
  )
}

function VirtualWorkItemStack<T extends { id: string }>({
  className,
  dataSurface,
  items,
  renderItem,
  rowHeight,
  targetItemId
}: {
  className: string
  dataSurface: string
  items: T[]
  renderItem: (item: T, index: number) => React.JSX.Element
  rowHeight: number
  targetItemId?: string
}): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const itemOrderKey = useMemo(() => items.map((item) => item.id).join('\u0000'), [items])
  const viewportHeight = Math.min(WORK_ITEM_VIRTUAL_MAX_HEIGHT, items.length * rowHeight)
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - WORK_ITEM_VIRTUAL_OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + WORK_ITEM_VIRTUAL_OVERSCAN * 2
  const end = Math.min(items.length, start + visibleCount)
  const visible = items.slice(start, end)
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])
  useLayoutEffect(() => {
    const targetIndex = targetItemId ? items.findIndex((item) => item.id === targetItemId) : -1
    const nextScrollTop = targetIndex >= 0 ? targetIndex * rowHeight : 0
    if (scrollRef.current) scrollRef.current.scrollTop = nextScrollTop
    setScrollTop(nextScrollTop)
  }, [dataSurface, itemOrderKey, items, rowHeight, targetItemId])
  return (
    <div
      ref={scrollRef}
      className={`${className} pws-virtual-scroll`}
      role={dataSurface === 'list' ? 'rowgroup' : 'list'}
      style={{ height: viewportHeight }}
      onScroll={handleScroll}
      data-work-item-virtualized="true"
      data-work-item-surface={dataSurface}
      data-total-work-items={items.length}
      data-rendered-work-items={visible.length}
    >
      <div className="pws-virtual-spacer" style={{ height: items.length * rowHeight }}>
        {visible.map((item, offset) => {
          const index = start + offset
          return (
            <div
              key={item.id}
              className="pws-virtual-item"
              role="presentation"
              style={{ height: rowHeight, transform: `translateY(${index * rowHeight}px)` }}
            >
              {renderItem(item, index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WorkItemControls({
  item,
  onAction,
  onTransfer,
  onAcceptance
}: {
  item: WorkItem
  onAction: (item: WorkItem, action: WorkItemControlAction) => Promise<void>
  onTransfer?: () => void
  onAcceptance?: (item: WorkItem, result: AcceptanceResult) => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [evidenceRefs, setEvidenceRefs] = useState(item.acceptance?.evidenceRefs.join('\n') ?? '')
  const [waiverReason, setWaiverReason] = useState(item.acceptance?.waiverReason ?? '')
  const run = async (action: WorkItemControlAction): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onAction(item, action)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const transitions = WORK_ITEM_TRANSITIONS[item.status]
  const canAcquire = (item.status === 'ready' || item.status === 'running') && Boolean(item.owner) && !item.lease
  const canRenew = Boolean(item.lease)
  const canRelease = Boolean(item.lease)
  const saveAcceptance = async (status: AcceptanceResult['status']): Promise<void> => {
    if (!onAcceptance) return
    const refs = [...new Set(evidenceRefs.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))]
    if (status === 'passed' && refs.length === 0) {
      setError(TEXT.acceptanceEvidenceRequired)
      return
    }
    if (status === 'waived' && !waiverReason.trim()) {
      setError(TEXT.acceptanceWaiverRequired)
      return
    }
    setBusy(true)
    setError('')
    try {
      await onAcceptance(item, {
        status,
        evidenceRefs: refs,
        verifiedAt: Date.now(),
        ...(status === 'waived' ? { waiverReason: waiverReason.trim() } : {})
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-work-item-controls" data-work-item-controls={item.id} aria-label={TEXT.workItemControls}>
      <div className="pws-work-item-control-actions">
        {onTransfer && (
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={onTransfer} data-work-item-transfer="open">
            {TEXT.transferWorkItem}
          </button>
        )}
        {transitions.map((status) => (
          <button
            key={status}
            type="button"
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => void run({ kind: 'transition', status })}
            data-work-item-transition={status}
            aria-label={TEXT.transitionTo(WORK_ITEM_STATUS_LABELS[status])}
          >
            {TEXT.transitionTo(WORK_ITEM_STATUS_LABELS[status])}
          </button>
        ))}
        {canAcquire && (
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void run({ kind: 'lease', operation: 'acquire' })} data-work-item-lease="acquire">
            {TEXT.acquireLease}
          </button>
        )}
        {canRenew && (
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void run({ kind: 'lease', operation: 'renew' })} data-work-item-lease="renew">
            {TEXT.renewLease}
          </button>
        )}
        {canRelease && (
          <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void run({ kind: 'lease', operation: 'release' })} data-work-item-lease="release">
            {TEXT.releaseLease}
          </button>
        )}
      </div>
      {onAcceptance && item.acceptanceSpec.length > 0 && (
        <details className="pws-acceptance-editor" data-work-item-acceptance={item.id}>
          <summary>{TEXT.acceptance} · {acceptancePresentation(item.acceptanceSpec.length, item.acceptance).label}</summary>
          <label>{TEXT.evidenceReferences}<textarea className="input" rows={2} value={evidenceRefs} onChange={(event) => setEvidenceRefs(event.target.value)} placeholder={TEXT.evidenceReferencesPlaceholder} disabled={busy} /></label>
          <label>{TEXT.waiverReason}<input className="input" value={waiverReason} onChange={(event) => setWaiverReason(event.target.value)} placeholder={TEXT.waiverReasonPlaceholder} disabled={busy} /></label>
          <div className="pws-acceptance-editor-actions">
            <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void saveAcceptance('pending')}>{TEXT.markAcceptancePending}</button>
            <button type="button" className="btn btn-primary btn-xs" disabled={busy} onClick={() => void saveAcceptance('passed')}>{TEXT.passAcceptance}</button>
            <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void saveAcceptance('failed')}>{TEXT.failAcceptance}</button>
            <button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void saveAcceptance('waived')}>{TEXT.waiveAcceptance}</button>
          </div>
        </details>
      )}
      {item.lease && <span className="pws-work-item-lease" data-work-item-lease-state="active">{TEXT.leaseActive} · {item.lease.fencingToken}</span>}
      {!item.lease && (item.status === 'ready' || item.status === 'running') && !item.owner && <span className="pws-work-item-lease pws-muted">{TEXT.leaseMissing}</span>}
      {error && <span className="pws-work-item-control-error" role="alert">{TEXT.controlFailed}: {error}</span>}
    </div>
  )
}

function StudioViewToggle({ value, onChange }: { value: StudioView; onChange: (view: StudioView) => void }): React.JSX.Element {
  const listRef = useRef<HTMLButtonElement>(null)
  const boardRef = useRef<HTMLButtonElement>(null)
  const select = (next: StudioView): void => {
    onChange(next)
    if (next === 'list') listRef.current?.focus()
    else boardRef.current?.focus()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    select(event.key === 'ArrowLeft' || event.key === 'Home' ? 'list' : 'board')
  }
  return (
    <div className="pws-segmented" role="group" aria-label={TEXT.switchWorkItemView} onKeyDown={handleKeyDown} data-work-item-view={value}>
      <button ref={listRef} type="button" className="btn btn-sm" aria-pressed={value === 'list'} data-view-option="list" onClick={() => onChange('list')}>{TEXT.list}</button>
      <button ref={boardRef} type="button" className="btn btn-sm" aria-pressed={value === 'board'} data-view-option="board" onClick={() => onChange('board')}>{TEXT.board}</button>
    </div>
  )
}

function SectionHeader({ id, title, count, action, onAction }: { id: string; title: string; count: number; action: string; onAction: () => void }): React.JSX.Element {
  return (
    <div className="pws-section-header">
      <div className="pws-section-title"><h2 id={id}>{title}</h2><span aria-label={TEXT.itemCount(count)}>{count}</span></div>
      <button type="button" className="btn btn-primary btn-sm" onClick={onAction} data-goal-action="create">{action}</button>
    </div>
  )
}

function EmptyState({ message, action, onAction }: { message: string; action: string; onAction: () => void }): React.JSX.Element {
  return (
    <div className="pws-empty"><p>{message}</p><button type="button" className="btn btn-ghost btn-sm" onClick={onAction}>{action}</button></div>
  )
}

function StatusBadge({ status, label }: { status: WorkItemStatus | Goal['status']; label: string }): React.JSX.Element {
  return <span className={`pws-status pws-status-${status}`}>{label}</span>
}

function AcceptanceBadge({ status, label }: { status: string; label: string }): React.JSX.Element {
  return <span className={`pws-acceptance pws-acceptance-${status}`}>{label}</span>
}

function ContractBlock({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="pws-contract-field"><h4>{label}</h4><p>{value}</p></div>
}
function ContractList({ label, values }: { label: string; values: string[] }): React.JSX.Element | null {
  if (values.length === 0) return null
  return <div className="pws-contract-field"><h4>{label}</h4><ul>{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul></div>
}

function riskLabel(risk: GoalRiskLevel): string {
  return GOAL_RISK_OPTIONS.find((option) => option.value === risk)?.label ?? risk
}

function budgetLabel(budget: Goal['budget']): string {
  if (!budget) return TEXT.noDueDate
  const parts: string[] = []
  if (budget.amount !== undefined) parts.push(`${budget.currency ?? ''} ${budget.amount}`.trim())
  if (budget.maxRuns !== undefined) parts.push(TEXT.runCount(budget.maxRuns))
  if (budget.maxConcurrentRuns !== undefined) parts.push(TEXT.concurrentRunCount(budget.maxConcurrentRuns))
  if (budget.maxTokens !== undefined) parts.push(`${budget.maxTokens} tokens`)
  return parts.join(' · ') || TEXT.noDueDate
}

function workItemFilterStorageKey(projectId: string): string {
  return `caogen.project-workspace.work-items.filters.v1:${projectId}`
}
function readStoredWorkItemFilters(projectId: string): WorkItemFilters {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(workItemFilterStorageKey(projectId)) ?? 'null') as Partial<WorkItemFilters> | null
    if (!parsed || typeof parsed.query !== 'string') return DEFAULT_WORK_ITEM_FILTERS
    const status = parsed.status === 'all' || WORK_ITEM_STATUSES.includes(parsed.status as WorkItemStatus) ? parsed.status : 'all'
    const owner = parsed.owner === 'unassigned' || parsed.owner === 'human' || parsed.owner === 'digital_worker' ? parsed.owner : 'all'
    const goalId = typeof parsed.goalId === 'string' && parsed.goalId ? parsed.goalId : 'all'
    return { query: parsed.query, status: status as WorkItemFilters['status'], goalId, owner }
  } catch {
    return DEFAULT_WORK_ITEM_FILTERS
  }
}
