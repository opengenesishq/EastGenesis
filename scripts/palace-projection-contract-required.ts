import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildOperationalActors, visibleOperationalActors, type OfficeOperationalActor } from '../src/renderer/src/components/office/operationalActors'
import { officeTaskLabels } from '../src/renderer/src/components/office/task-label-model'
import type { WorkItem } from '../src/shared/project-workspace-types'
import type { ProjectPortfolioTimelineEntry } from '../src/shared/project-portfolio-types'

type ContractStatus = 'passed' | 'failed'

interface Check {
  id: string
  status: ContractStatus
  detail: string
}

const now = Date.now()
const fixture = [
  ['wi-backlog', 'backlog'],
  ['wi-running', 'running'],
  ['wi-approval', 'waiting_approval'],
  ['wi-blocked', 'blocked'],
  ['wi-done', 'done'],
  ['wi-failed', 'failed']
] as const

function workItem(id: string, status: string): WorkItem {
  return {
    schemaVersion: 1,
    id,
    projectId: 'project-palace-contract',
    title: `Contract ${id}`,
    description: '',
    type: 'task',
    status,
    priority: 50,
    dependencyIds: [],
    runRefs: [],
    artifactRefs: [],
    acceptanceSpec: [],
    createdAt: now - 10_000,
    updatedAt: now,
    revision: 1
  } as WorkItem
}

function assert(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail)
}

function expectedActivity(status: string): OfficeOperationalActor['activity'] {
  if (status === 'running') return 'working'
  if (status === 'failed') return 'error'
  if (status === 'waiting_approval' || status === 'blocked') return 'awaiting'
  if (status === 'done') return 'completed'
  return 'idle'
}

async function main(): Promise<void> {
  const checks: Check[] = []
  const record = (id: string, detail: string, operation: () => void): void => {
    try {
      operation()
      checks.push({ id, status: 'passed', detail })
    } catch (error) {
      checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const workItems = fixture.map(([id, status]) => workItem(id, status))
  const timeline = workItems.map((item): ProjectPortfolioTimelineEntry => ({
    id: item.id,
    kind: 'work_item',
    projectId: item.projectId,
    title: item.title,
    status: item.status,
    startAt: item.createdAt,
    endAt: item.dueAt ?? item.updatedAt,
    dueAt: item.dueAt,
    progress: item.status === 'done' ? 1 : 0,
    overdue: false,
    dependencyIds: item.dependencyIds,
    crossProjectDependencyIds: [],
    waitingOnCrossProjectDependencyIds: [],
    blockedByCrossProjectDependencyIds: []
  }))
  const actors = buildOperationalActors({
    media: { jobs: [], productions: [], providers: [] },
    projects: [],
    sessions: {},
    workItems
  })

  record('canonical-work-item-identity', '每个 WorkItem 只生成一个带原始 workItemId 的宫苑运营投影', () => {
    assert(actors.length === workItems.length, `actor count ${actors.length} !== work item count ${workItems.length}`)
    assert(new Set(actors.map((actor) => actor.workItemId)).size === workItems.length, 'workItemId projection contains duplicates')
    for (const item of workItems) {
      const actor = actors.find((candidate) => candidate.workItemId === item.id)
      assert(actor, `missing palace actor for ${item.id}`)
      assert(actor.sourceId === item.id, `${item.id} sourceId drifted to ${actor.sourceId}`)
      assert(actor.kind === 'work-item', `${item.id} was projected as ${actor.kind}`)
    }
  })

  record('status-parity', '宫苑 actor 的 status/activity 与列表 WorkItem 状态使用同一来源', () => {
    for (const item of workItems) {
      const actor = actors.find((candidate) => candidate.workItemId === item.id)
      assert(actor, `missing actor for ${item.id}`)
      assert(actor.status === item.status, `${item.id} status ${actor.status} !== ${item.status}`)
      assert(actor.activity === expectedActivity(item.status), `${item.id} activity ${actor.activity} is not mapped from ${item.status}`)
    }
  })

  record('timeline-parity', '二维列表与时间线保留同一 WorkItem 身份和状态', () => {
    assert(timeline.length === workItems.length, `timeline count ${timeline.length} !== work item count ${workItems.length}`)
    assert(new Set(timeline.map((entry) => entry.id)).size === timeline.length, 'timeline contains duplicate identities')
    for (const item of workItems) {
      const entry = timeline.find((candidate) => candidate.id === item.id && candidate.kind === 'work_item')
      assert(entry, `missing timeline entry for ${item.id}`)
      assert(entry.projectId === item.projectId, `${item.id} timeline project drifted`)
      assert(entry.title === item.title, `${item.id} timeline title drifted`)
      assert(entry.status === item.status, `${item.id} timeline status ${entry.status} !== ${item.status}`)
    }
  })

  record('actionability-parity', '完成项保持只读历史，执行中/等待处理/失败项保留操作入口', () => {
    for (const actor of actors) {
      const actionable = actor.status === 'running' || actor.status === 'waiting_approval' ||
        actor.status === 'blocked' || actor.status === 'failed'
      assert(actor.actionable === actionable, `${actor.workItemId} actionable=${actor.actionable} for status=${actor.status}`)
    }
  })

  record('label-parity', '宫苑标签集合覆盖同一批 WorkItem，且标题与状态不改写', () => {
    const labels = officeTaskLabels({
      sessionIds: [],
      sessions: {},
      actors,
      selectedSessionId: null,
      selectedActorId: null,
      positionedIds: actors.map((actor) => actor.id),
      positions: actors.map(() => [0, 0, 0])
    })
    assert(labels.length === actors.length, `label count ${labels.length} !== actor count ${actors.length}`)
    for (const actor of actors) {
      const label = labels.find((candidate) => candidate.id === actor.id)
      assert(label, `missing label for ${actor.id}`)
      assert(label.title === actor.title, `${actor.id} title drifted`)
      assert(label.status === actor.status, `${actor.id} label status drifted`)
      assert(label.activity === actor.activity, `${actor.id} label activity drifted`)
    }
  })

  record('bounded-projection', '宫苑容量限制只截断显示数量，不改变 canonical actor 的身份', () => {
    const visible = visibleOperationalActors(actors, null, 3)
    assert(visible.length === 3, `visible actor count ${visible.length} !== configured bound 3`)
    assert(visible.every((actor) => actor.actionable), 'bounded projection exposed a non-actionable historical actor')
    assert(new Set(visible.map((actor) => actor.workItemId)).size === visible.length, 'bounded projection duplicated a WorkItem')
  })

  const failed = checks.filter((check) => check.status === 'failed')
  const report = {
    schemaVersion: 1,
    contract: 'V2-008 palace projection / list / timeline consistency',
    generatedAt: new Date().toISOString(),
    source: {
      workItems: workItems.map((item) => ({ id: item.id, status: item.status })),
      timeline: timeline.map((entry) => ({ id: entry.id, kind: entry.kind, status: entry.status })),
      projection: actors.map((actor) => ({
        id: actor.id,
        kind: actor.kind,
        sourceId: actor.sourceId,
        workItemId: actor.workItemId,
        status: actor.status,
        activity: actor.activity,
        actionable: actor.actionable
      }))
    },
    checks,
    status: failed.length === 0 ? 'passed' : 'failed',
    summary: `${checks.filter((check) => check.status === 'passed').length}/${checks.length} checks passed`
  }
  const output = resolve(process.cwd(), 'test-results/palace-projection-contract/latest.json')
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length > 0) throw new Error(failed.map((check) => `${check.id}: ${check.detail}`).join('\n'))
  console.log(`palace projection contract: PASS (${report.summary})`)
  console.log(`report: ${output}`)
}

void main()
