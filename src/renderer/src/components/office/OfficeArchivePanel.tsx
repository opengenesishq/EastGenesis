import type { MediaJobRecord } from '../../../../shared/media-types'
import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'
import type { WorkflowEvidenceRecord, WorkflowLedgerRendererSelection } from '../../../../shared/types'

interface ArchiveSession { id: string; title: string; status: string; businessLineId: string }

/**
 * Read-only archive index used when the archive tower has no single Session
 * to bind. It is intentionally a projection over the existing snapshots: it
 * never creates a task, result, acceptance, or recovery record.
 */
export default function OfficeArchivePanel({ sessions, workItems, projects, jobs, ledger, evidence, ledgerError, onClose }: {
  sessions: ArchiveSession[]
  workItems: WorkItem[]
  projects: ProjectWorkspace[]
  jobs: MediaJobRecord[]
  ledger: WorkflowLedgerRendererSelection | null
  evidence: WorkflowEvidenceRecord[]
  ledgerError: string
  onClose: () => void
}): React.JSX.Element {
  const runs = ledger?.runs.items ?? []
  const artifacts = ledger?.artifacts.items ?? []
  const acceptances = ledger?.acceptances.items ?? []
  const evidenceLinks = ledger?.evidenceLinks.items ?? []
  const recoveryRuns = runs.filter((run) => ['waiting_approval', 'waiting_reconciliation', 'recovering', 'failed'].includes(run.status))
  return <section className="office-archive-panel no-drag" data-office-archive-panel role="dialog" aria-label="成果与证据档案">
    <header>
      <div><span className="office-selection-kicker">成果与证据档案</span><h2>全局档案索引</h2></div>
      <button type="button" className="btn btn-ghost btn-sm" data-office-archive-close onClick={onClose}>返回控制室</button>
    </header>
    <p className="office-archive-explain">此处汇总现有 Session、WorkItem、MediaJob、Project 与 Workflow Ledger 的真实身份；空列表表示当前没有可绑定记录。</p>
    {ledgerError && <p className="office-archive-error" role="alert" data-office-archive-ledger-error>{ledgerError}</p>}
    <div className="office-archive-grid">
      <ArchiveSection label="Session" count={sessions.length}>
        {sessions.map((session) => <div key={session.id} data-office-archive-session={session.id}><strong>{session.title}</strong><span>{session.businessLineId} · {session.status}</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="WorkItem" count={workItems.length}>
        {workItems.map((item) => <div key={item.id} data-office-archive-work-item={item.id} data-office-archive-artifact-refs={item.artifactRefs.join('|')}>
          <strong>{item.title}</strong>
          <span>{item.status} · {item.businessLineId ?? '未指定业务线'} · Artifact {item.artifactRefs.length}</span>
          {item.artifactRefs.length > 0 && <small>Artifact refs: {item.artifactRefs.join(', ')}</small>}
        </div>)}
      </ArchiveSection>
      <ArchiveSection label="MediaJob" count={jobs.length}>
        {jobs.map((job) => <div key={job.id} data-office-archive-media-job={job.id} data-office-archive-media-work-item={job.workItemId ?? ''} data-office-archive-media-run={job.runId ?? ''}><strong>{job.operation}</strong><span>{job.status} · {job.id}{job.workItemId ? ` · WorkItem ${job.workItemId}` : ''}</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="Project" count={projects.length}>
        {projects.map((project) => <div key={project.id} data-office-archive-project={project.id}><strong>{project.name}</strong><span>{project.status} · {project.id}</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="Run" count={runs.length}>
        {runs.map((run) => <div key={run.id} data-office-archive-run={run.id}><strong>{run.id}</strong><span>{run.status} · WorkItem {run.workItemId}</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="Recovery" count={recoveryRuns.length}>
        {recoveryRuns.map((run) => <div key={run.id} data-office-archive-recovery={run.id}><strong>{run.id}</strong><span>{run.status} · WorkItem {run.workItemId}</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="Artifact" count={artifacts.length}>
        {artifacts.map((artifact) => <div key={artifact.id} data-office-archive-artifact={artifact.id}><strong>{artifact.title}</strong><span>{artifact.kind} · {artifact.id}</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="Acceptance" count={acceptances.length}>
        {acceptances.map((acceptance) => <div key={acceptance.id} data-office-archive-acceptance={acceptance.id}><strong>{acceptance.id}</strong><span>{acceptance.status} · {acceptance.criteria.length} criteria · {acceptance.evidenceRefs.length} evidence refs</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="Evidence" count={evidence.length}>
        {evidence.map((record) => <div key={record.id} data-office-archive-evidence={record.id}><strong>{record.title}</strong><span>{record.kind} · {record.source} · {record.evidenceId}</span></div>)}
      </ArchiveSection>
      <ArchiveSection label="EvidenceLink" count={evidenceLinks.length}>
        {evidenceLinks.map((link) => <div key={link.id} data-office-archive-evidence-link={link.id}><strong>{link.id}</strong><span>{link.relation} · {link.evidenceId}{link.acceptanceId ? ` · Acceptance ${link.acceptanceId}` : ''}</span></div>)}
      </ArchiveSection>
    </div>
  </section>
}

function ArchiveSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }): React.JSX.Element {
  return <article className="office-archive-section" data-office-archive-section={label} data-office-archive-count={count}><h3>{label}<span>{count}</span></h3>{count === 0 ? <p className="office-archive-empty" data-office-archive-empty={label}>暂无记录</p> : <div>{children}</div>}</article>
}
