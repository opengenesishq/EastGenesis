import { AUTO_MODEL, AUTO_PROVIDER_ID, type AgentDeskApi, type AgentEvent } from '../../../shared/types'

export interface NativeDraftRequest {
  title: string
  prompt: string
  businessLineId: string
  signal?: AbortSignal
  onSession?: (id: string) => void
}

/** Drafts are ordinary read-only runs with real routing, costs and transcripts. */
export async function generateNativeDraft(api: AgentDeskApi, input: NativeDraftRequest): Promise<{ text: string; sessionId: string }> {
  if (input.signal?.aborted) throw new Error('草稿生成已取消')
  const meta = await api.createSession({ cwd: '', unassigned: true, businessLineId: input.businessLineId,
    experienceModeOverride: 'assistant', model: AUTO_MODEL, providerId: AUTO_PROVIDER_ID,
    routingScope: 'global', taskStrategy: 'view', initialPrompt: input.prompt, title: input.title })
  input.onSession?.(meta.id)
  const text = await collectAssistantResult(api, meta.id, input.prompt, input.signal)
  return { text, sessionId: meta.id }
}

function collectAssistantResult(api: AgentDeskApi, sessionId: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = ''
    let settled = false
    let unsubscribe = (): void => undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else void resolveDraftText(api, sessionId, content).then(resolve, reject)
    }
    const stop = (message: string): void => {
      void api.interrupt(sessionId).catch(() => undefined)
      finish(new Error(message))
    }
    const abort = (): void => { stop('草稿生成已取消，可在任务历史查看已产生的内容') }
    const timer = setTimeout(() => stop('草稿生成超时，已请求停止；可重试或手工填写'), 120_000)
    unsubscribe = api.onSessionEvent((id, event) => {
      if (id !== sessionId) return
      content = draftEventText(event, content)
      if (content.length > 200_000) { stop('草稿超过长度限制，请缩小生成范围'); return }
      if (event.kind === 'turn-result') finish(event.isError ? new Error('模型未能完成草稿；请查看任务详情或手工填写') : undefined)
      if (event.kind === 'status' && event.status === 'error') finish(new Error(event.error || '草稿任务执行失败'))
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    void api.sendMessage(sessionId, prompt).then((started) => { if (!started) finish(new Error('草稿任务未能启动')) })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

function draftEventText(event: AgentEvent, current: string): string {
  if (event.kind === 'text-delta') return current + event.text
  if (event.kind === 'assistant-message') return event.blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n') || current
  if (event.kind === 'turn-result') return event.resultText || current
  return current
}

async function resolveDraftText(api: AgentDeskApi, id: string, streamed: string): Promise<string> {
  if (streamed.trim()) return streamed
  const entries = await api.getTranscript(id)
  const last = entries.filter((entry) => entry.event.kind === 'assistant-message').at(-1)
  const text = last ? draftEventText(last.event, '') : ''
  if (!text.trim()) throw new Error('模型未返回草稿内容；任务转录已保留')
  return text
}
