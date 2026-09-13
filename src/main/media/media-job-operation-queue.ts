import { withSessionOperationQueue } from '../session-operation-queue'
import { requiredId } from '../project-workspace/codec'
import { mediaStoreRoot } from './media-store-root'

/** Lock before reading state or choosing a transition, through final settlement.
 * This namespace is distinct from the nested Effect gateway's Session queue. */
export function withMediaJobOperationQueue<T>(rootDir: string, jobId: string, task: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([mediaStoreRoot(rootDir), requiredId(jobId, 'mediaJobId')])
  return withSessionOperationQueue(`media-job-lifecycle:${key}`, task)
}
