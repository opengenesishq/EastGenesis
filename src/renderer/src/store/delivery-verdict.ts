import type { StudioResultSnapshot } from '../../../shared/types'

/**
 * 交付判定:仅两种取值,口径统一为 acceptances 状态集合。
 * - 'verifiable':至少存在一条当前验收记录,且全部 acceptance ∈ {passed, waived}
 * - 'not_done'  :没有当前验收记录,或存在任意 {pending, verifying, failed}
 */
export type DeliveryVerdict = 'verifiable' | 'not_done'

/** verdict 派生详情:聚合计数 + 辅助展示用的模型自报完成信号(不参与判定)。 */
export interface DeliveryVerdictDetail {
  verdict: DeliveryVerdict
  total: number
  passed: number
  waived: number
  failed: number
  pending: number
  verifying: number
  /**
   * 辅助信号:模型是否自报过完成(任意 run.status==='completed' 或 goal.status==='completed')。
   * 仅用于横幅文案「模型运行已结束,但验收未通过」,绝不参与 verdict 计算。
   */
  modelReportedDone: boolean
}

/**
 * 纯函数:从 snapshot.acceptances 推导交付判定。
 *
 * 判定口径(来自 PRD P0-1 / AC-1,且采纳架构 §8.1 默认决议):
 *  - 至少一条当前 acceptance 且全部 ∈ {passed, waived} → verifiable
 *  - 没有当前 acceptance → not_done（fail-closed,不能把没有验收记录当作已交付）
 *  - 存在任意 {pending, verifying, failed} → not_done
 *
 * 不读取 goal.status / TaskRun.status / WorkItem.status 作为判定依据;
 * 这些字段仅作横幅辅助文案(见 modelReportedDone)。
 */
export function deriveDeliveryVerdict(snapshot: StudioResultSnapshot): DeliveryVerdictDetail {
  const acceptances = (snapshot.acceptances ?? [])
    .filter((acceptance) => acceptance.deliveryScope !== 'historical')
  let passed = 0
  let waived = 0
  let failed = 0
  let pending = 0
  let verifying = 0
  for (const acceptance of acceptances) {
    switch (acceptance.status) {
      case 'passed':
        passed++
        break
      case 'waived':
        waived++
        break
      case 'failed':
        failed++
        break
      case 'pending':
        pending++
        break
      case 'verifying':
        verifying++
        break
    }
  }
  const total = acceptances.length
  // A result without a current Acceptance has no evidence that the requested
  // deliverable was reviewed. Treat it as incomplete rather than allowing a
  // vacuous "all checks passed" result to unlock Goal completion.
  const notDone = total === 0 || failed > 0 || pending > 0 || verifying > 0
  const modelReportedDone =
    snapshot.goal?.status === 'completed' ||
    snapshot.runs.some((run) => run.status === 'completed')
  return {
    verdict: notDone ? 'not_done' : 'verifiable',
    total,
    passed,
    waived,
    failed,
    pending,
    verifying,
    modelReportedDone
  }
}

/**
 * Goal 完成门禁守卫:verifiable 才允许标记完成;not_done 一律阻断(AC-3)。
 * 任何「标记 Goal 完成」正向 CTA 必须过此守卫,UI 不提供绕过路径。
 */
export function canMarkGoalComplete(verdict: DeliveryVerdict): boolean {
  return verdict === 'verifiable'
}
