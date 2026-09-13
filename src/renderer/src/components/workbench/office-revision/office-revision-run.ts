import type { AgentDeskApi, SendMessagePayload } from '../../../../../shared/types'
import type { OfficeRevisionPlan, OfficeRevisionResult } from '../../../../../shared/office-revision-types'
import { canonicalRevisionMatches, officeRevisionIntent, parseRevisionToolResult } from './office-revision-model'

/** Use the original task's normal tool turn, including permission requests and durable Effect registration. */
export function runOfficeRevision(input: {
  api: Pick<AgentDeskApi, 'onSessionEvent' | 'getStudioResultSnapshot'>
  sessionId: string
  plan: OfficeRevisionPlan
  send(payload: SendMessagePayload, sessionId: string): Promise<void>
  timeoutMs?: number
}): Promise<OfficeRevisionResult> {
  const intent = officeRevisionIntent(input.plan, input.sessionId)
  return new Promise((resolve, reject) => {
    let settled = false
    let verifying = false
    let unsubscribe = (): void => undefined
    const finish = (error?: Error, result?: OfficeRevisionResult): void => {
      if (settled) return
      settled = true; clearTimeout(timer); unsubscribe()
      if (result) resolve(result)
      else reject(error ?? new Error('本轮未确认新的成果版本。'))
    }
    const timer = setTimeout(() => finish(new Error('尚未确认修改结果。请在原任务查看审批或执行记录，勿把请求已发送当作修改完成。')), input.timeoutMs ?? 120_000)
    unsubscribe = input.api.onSessionEvent((id, event) => {
      if (id !== input.sessionId || settled) return
      if (event.kind === 'tool-result' && !event.isError) {
        const result = parseRevisionToolResult(event.content, input.plan)
        if (result) {
          verifying = true
          void input.api.getStudioResultSnapshot(id).then((snapshot) => {
            if (!canonicalRevisionMatches(snapshot, result, input.plan)) throw new Error('工具回执尚未与任务成果登记一致，请查看原任务记录。')
            finish(undefined, result)
          }).catch((cause: unknown) => finish(cause instanceof Error ? cause : new Error(String(cause))))
        }
      }
      if (event.kind === 'turn-result' && !verifying) finish(new Error('本轮结束，尚未确认指定修改产生的新版本。请查看原任务反馈。'))
      if (event.kind === 'status' && event.status === 'error' && !verifying) finish(new Error(event.error || '修改执行失败。'))
    })
    void input.send({ text: '请按我已确认的修改预览，只改选中的段落或单元格，保留其它内容与旧版本。保存新版本后，说明已完成的修改和仍需核验的事项。', officeRevisionIntent: intent }, input.sessionId)
      .catch((cause: unknown) => finish(cause instanceof Error ? cause : new Error(String(cause))))
  })
}
