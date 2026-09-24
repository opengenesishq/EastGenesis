import { sessionManager } from '../sessionManager'
import { createWorkflowEvidence } from '../task/workflow-ledger-api'
import { PullRequestWorkspaceAdapter } from './pull-request-workspace-adapters'
import { inspectLocalPullRequestRepository, PullRequestWorkspaceCli } from './pull-request-workspace-cli'
import { PullRequestWorkspaceService } from './pull-request-workspace-service'

const services = new Map<string, PullRequestWorkspaceService>()
export function getPullRequestWorkspaceService(root: string): PullRequestWorkspaceService {
  let service = services.get(root)
  if (service) return service
  service = new PullRequestWorkspaceService(root, {
    meta: id => sessionManager.get(id)?.meta,
    inspect: inspectLocalPullRequestRepository,
    recordEvidence: async (meta, evidence, path) => {
      if (!meta.workspaceId) return
      await createWorkflowEvidence({ evidenceId: evidence.id, projectId: meta.workspaceId,
        ...(meta.goalId ? { goalId: meta.goalId } : {}), ...(meta.workItemId ? { workItemId: meta.workItemId } : {}),
        kind: 'review_result', title: `用户选择 PR/MR #${evidence.pullRequest.number} 的 ${evidence.selectedFeedback.length} 条意见`,
        summary: 'External review text selected into a local draft by the user; no automatic execution or remote write.',
        uri: evidence.pullRequest.url, mediaType: 'application/json', contentDigest: `sha256:${evidence.contentDigest}`,
        metadata: { sourcePath: path, snapshotId: evidence.snapshotId, snapshotDigest: evidence.snapshotDigest,
          headSha: evidence.pullRequest.headSha, feedbackIds: evidence.selectedFeedback.map(item => item.id), sessionId: meta.id }
      }, root, { source: 'human', verifier: 'pull-request-workspace-explicit-selection', observedAt: evidence.selectedAt })
    }
  }, new PullRequestWorkspaceAdapter(new PullRequestWorkspaceCli()))
  services.set(root, service)
  return service
}
