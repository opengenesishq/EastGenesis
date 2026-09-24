import { getSettings } from '../settings'
import { sessionManager } from '../sessionManager'
import { inspectManagedWorktreeRegistryRecord } from '../managed-worktree-lifecycle'
import { listTaskRuns } from '../task/task-snapshot'
import { effectRecordIntegrityMatches } from '../task/effect-record-integrity'
import { expandGitTextTemplate, normalizeDesktopGitPreferences } from '../../shared/desktop-git-preferences'
import { inspectPullRequestCapability } from './pull-request-effect'
import { WorktreePullRequestDraftService } from './worktree-pr-draft-service'

const services = new Map<string, WorktreePullRequestDraftService>()
export function getWorktreePullRequestDraftService(root: string): WorktreePullRequestDraftService {
  let service = services.get(root)
  if (service) return service
  service = new WorktreePullRequestDraftService(root, {
    meta: id => sessionManager.get(id)?.meta,
    record: id => { const result = inspectManagedWorktreeRegistryRecord(id, root); if (!result.ok) throw new Error('error' in result ? result.error : 'Worktree 记录无法读取'); return result.record },
    capability: inspectPullRequestCapability,
    defaults: (meta, snapshot) => {
      const preferences = normalizeDesktopGitPreferences(getSettings().gitPreferences)
      const values = { title: meta.title, branch: snapshot.binding.branch, baseBranch: snapshot.baseBranch,
        summary: snapshot.commits.slice(0, 20).map(commit => `- ${commit.subject}`).join('\n') }
      return { title: expandGitTextTemplate(preferences.pullRequestTitleTemplate, values),
        body: expandGitTextTemplate(preferences.pullRequestBodyTemplate, values) }
    },
    effect: async (sessionId, operationId) => {
      const runs = await listTaskRuns(`operation:${operationId}`, root)
      const matching = runs.filter(run => run.operation?.operationId === operationId && run.operation.sourceSessionId === sessionId)
      if (matching.length > 1) throw new Error('原 PR 操作存在多个运行记录，请先核对')
      const effects = matching[0]?.effects ?? []
      if (effects.some(effect => !effectRecordIntegrityMatches(effect))) throw new Error('原 PR 效果记录摘要无法核对')
      return [...effects].sort((a, b) => b.updatedAt - a.updatedAt || b.generation - a.generation)[0]
    }
  })
  services.set(root, service)
  return service
}
