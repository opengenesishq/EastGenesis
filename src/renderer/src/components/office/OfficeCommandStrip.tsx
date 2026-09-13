import { useT } from '../../i18n'
import type { OfficeRealtimeSummary, OfficeSessionActivity } from './model'
import type { MediaOperationalSummary, ProjectOperationalSummary } from './operationalSummary'
import type { OfficeBusinessView } from './officeReturnContext'
import type { OfficeCostSummary } from './businessOperationalSummary'
import OfficeActionFeedback from './OfficeActionFeedback'

function moneyShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`
}

type OfficeActivitySummary = Record<OfficeSessionActivity, number> & { total: number }

export default function OfficeCommandStrip({ businessView, activity, packetCount, realtime, projects, media, cost }: {
  businessView: OfficeBusinessView
  activity: OfficeActivitySummary
  packetCount: number
  realtime: OfficeRealtimeSummary
  projects: ProjectOperationalSummary
  media: MediaOperationalSummary
  cost: OfficeCostSummary
}): React.JSX.Element {
  const t = useT()
  const assistantMetrics: Array<[string, string | number]> = [
    ['officeMetricSessions', activity.total], ['officeMetricWorking', activity.working],
    ['officeMetricAwaiting', activity.awaiting], ['officeMetricCompleted', activity.completed],
    ['officeMetricFailed', activity.error], ['officeMetricCost', partialCost(cost.knownUsd, cost.unknownCount, cost.sources)]
  ]
  const projectMetrics: Array<[string, string | number]> = [
    ['officeMetricProjects', projects.projects], ['officeMetricWorkItems', projects.workItems],
    ['officeMetricWorking', projects.running], ['officeMetricAwaiting', projects.approvals],
    ['officeMetricBlocked', projects.blocked], ['officeMetricFailed', projects.failed]
  ]
  const videoMetrics: Array<[string, string | number]> = [
    ['officeMetricProductions', media.productions], ['officeMetricMediaJobs', media.jobs],
    ['officeMetricWorking', media.running], ['officeMetricReconciliation', media.waitingReconciliation],
    ['officeMetricFailed', media.failed],
    ['officeMetricMediaCost', `${partialCost(media.actualUsd, media.unknownActualCostCount, media.jobs)} / ${partialCost(media.estimatedUsd, media.unknownEstimatedCostCount, media.jobs)}`]
  ]
  const operationsMetrics: Array<[string, string | number]> = [
    ['officeMetricPackets', packetCount], ['officeMetricRouted', realtime.routedSessions],
    ['officeMetricFailover', realtime.failoverSessions], ['officeMetricWorkspace', realtime.workspaceChangedFiles],
    ['officeMetricGit', realtime.gitDirtySessions], ['officeMetricIsolated', realtime.isolatedSessions]
  ]
  const metrics = businessView === 'assistant' || businessView.startsWith('business-line:')
    ? assistantMetrics
    : businessView === 'project'
      ? projectMetrics
      : businessView === 'video'
        ? videoMetrics
        : [
            ['officeMetricSessions', activity.total],
            ['officeMetricWorkItems', projects.workItems],
            ['officeMetricMediaJobs', media.jobs],
            ['officeMetricWorking', activity.working],
            ['officeMetricAwaiting', activity.awaiting],
            ['officeMetricFailed', activity.error],
            ...operationsMetrics
          ] as Array<[string, string | number]>
  return <div className="office-command-strip no-drag">
    {metrics.map(([label, value], index) => <div className="office-metric" data-office-metric={label} key={`${label}:${index}`}><span>{t(label)}</span><strong>{value}</strong></div>)}
    <OfficeActionFeedback />
  </div>
}

function partialCost(value: number, unknownCount: number, total: number): string {
  if (total > 0 && unknownCount === total) return '—'
  return `${moneyShort(value)}${unknownCount > 0 ? ' +' : ''}`
}
