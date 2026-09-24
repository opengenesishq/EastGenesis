import type { SessionMeta } from '../shared/types'
import type { VoiceInputPreparation, VoiceInputTranscriptionInput, VoiceInputTranscriptionResult } from '../shared/voice-input-types'
import { taskExecutionAuthorityBindingDigest } from './permission/task-execution-authority-store'

interface VoiceService {
  prepare(owner: number, id: string): VoiceInputPreparation
  transcribe(owner: number, input: VoiceInputTranscriptionInput): Promise<VoiceInputTranscriptionResult>
  cancel(owner: number, id: string): void
  cancelOwner(owner: number): void
}
export class CompanionVoiceController {
  private entries = new Map<number, { preparation: VoiceInputPreparation; binding: string }>()
  private permissions = new Map<number, number>()
  constructor(private service: VoiceService, private current: (owner: number) => SessionMeta | undefined) {}
  private task(owner: number): SessionMeta {
    const meta = this.current(owner)
    if (!meta || meta.status === 'closed') throw new Error('请在展开的随侍窗口中选择一个打开的任务。')
    return meta
  }
  prepare(owner: number, id: string): VoiceInputPreparation {
    const meta = this.task(owner)
    if (meta.id !== id) throw new Error('语音输入不属于当前随侍任务。')
    const binding = taskExecutionAuthorityBindingDigest(meta)
    this.cancelOwner(owner)
    const preparation = this.service.prepare(owner, id)
    this.entries.set(owner, { preparation, binding })
    return preparation
  }
  private assertCurrent(owner: number, id?: string): void {
    const entry = this.entries.get(owner)
    let meta: SessionMeta
    try { meta = this.task(owner) } catch (error) { this.cancelOwner(owner); throw error }
    let binding: string
    try { binding = taskExecutionAuthorityBindingDigest(meta) } catch (error) { this.cancelOwner(owner); throw error }
    if (!entry || entry.preparation.expiresAt <= Date.now() || id && entry.preparation.preparationId !== id || entry.preparation.contextId !== meta.id || entry.binding !== binding) {
      this.cancelOwner(owner); throw new Error('随侍任务或录音已变化，请重新录音。')
    }
  }
  async permission(owner: number, request: () => Promise<boolean>): Promise<boolean> {
    this.assertCurrent(owner)
    const granted = await request()
    this.assertCurrent(owner)
    if (granted) this.permissions.set(owner, Date.now() + 15000)
    return granted
  }
  permitsMicrophone(owner: number): boolean {
    try { this.assertCurrent(owner); return (this.permissions.get(owner) ?? 0) > Date.now() } catch { return false }
  }
  async transcribe(owner: number, input: VoiceInputTranscriptionInput): Promise<VoiceInputTranscriptionResult> {
    this.assertCurrent(owner, input?.preparationId)
    const result = await this.service.transcribe(owner, input)
    this.assertCurrent(owner, input.preparationId)
    return result
  }
  cancel(owner: number, id: string): void {
    if (this.entries.get(owner)?.preparation.preparationId === id) this.cancelOwner(owner)
  }
  cancelOwner(owner: number): void { this.entries.delete(owner); this.permissions.delete(owner); this.service.cancelOwner(owner) }
  prune(): void { for (const owner of this.entries.keys()) { try { this.assertCurrent(owner) } catch { /* assertCurrent cancels invalid entries. */ } } }
}
