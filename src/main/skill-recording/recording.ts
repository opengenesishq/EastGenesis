import { randomUUID } from 'node:crypto'
import type { SkillRecordingSaveResult, SkillRecordingSource, SkillRecordingStep, SkillRecordingView } from '../../shared/skill-recording-types'
import { containsSensitiveText, redactSensitiveText } from '../security/secret-redaction'

export interface RecordedImage { bytes: Uint8Array; previewDataUrl: string; width: number; height: number }
interface Recording { view: SkillRecordingView; images: Map<string, RecordedImage>; capturing: boolean }
interface Dependencies {
  sources(): Promise<SkillRecordingSource[]>
  capture(source: SkillRecordingSource): Promise<RecordedImage>
  save(name: string, markdown: string, images: Array<{ filename: string; bytes: Uint8Array }>): SkillRecordingSaveResult
  now?(): number
  temporary?(): boolean
}
const MAX_STEPS = 40, MAX_IMAGES = 12, MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_RECORDING_BYTES = 32 * 1024 * 1024

/** Explicit, manual step collection. No input hook, watcher, transcript, or background capture. */
export class SkillRecordingService {
  private readonly recordings = new Map<number, Recording>()
  constructor(private readonly dependencies: Dependencies) {}
  begin(owner: number, raw: unknown): SkillRecordingView {
    const input = record(raw, ['name', 'description', 'consent', 'allowScreenshots'])
    if (input.consent !== true || typeof input.allowScreenshots !== 'boolean') throw new Error('请先确认要开始的记录范围。')
    const name = text(input.name, 63)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('技能名称须使用小写字母、数字和连字符，最多 63 个字符。')
    if (this.recordings.has(owner)) throw new Error('请先结束或取消本窗口已有的记录。')
    const view: SkillRecordingView = { id: randomUUID(), phase: 'recording', name, description: text(input.description, 500),
      allowScreenshots: input.allowScreenshots, temporary: this.dependencies.temporary?.() === true, startedAt: this.now(), steps: [] }
    this.recordings.set(owner, { view, images: new Map(), capturing: false })
    return this.view(this.recordings.get(owner)!)
  }
  add(owner: number, id: unknown, raw: unknown): SkillRecordingView {
    const current = this.active(owner, id), input = record(raw, ['action', 'outcome'])
    if (current.view.steps.length >= MAX_STEPS) throw new Error('一次最多记录 40 个步骤。')
    current.view.steps.push({ id: randomUUID(), action: text(input.action, 2000), outcome: text(input.outcome, 2000), capturedAt: this.now() })
    return this.view(current)
  }
  remove(owner: number, id: unknown, stepId: unknown, imageOnly = false): SkillRecordingView {
    const current = this.active(owner, id), step = this.step(current, stepId)
    current.images.delete(step.id)
    delete step.image
    if (!imageOnly) current.view.steps = current.view.steps.filter(item => item.id !== step.id)
    return this.view(current)
  }
  async sources(owner: number, id: unknown): Promise<SkillRecordingSource[]> {
    const current = this.active(owner, id)
    if (!current.view.allowScreenshots) throw new Error('开始时未允许示范截图；可以继续记录文字。')
    const sources = await this.dependencies.sources()
    if (this.active(owner, id) !== current) throw new Error('记录已经结束。')
    return sources.map(source => ({ id: source.id, name: source.name, kind: source.kind }))
  }
  async capture(owner: number, id: unknown, stepId: unknown, raw: unknown): Promise<SkillRecordingView> {
    const current = this.active(owner, id), step = this.step(current, stepId)
    if (!current.view.allowScreenshots) throw new Error('开始时未允许示范截图；可以继续记录文字。')
    if (current.capturing) throw new Error('已有画面正在采集。')
    if (!current.images.has(step.id) && current.images.size >= MAX_IMAGES) throw new Error('一次最多保留 12 张截图。')
    const source = record(raw, ['id', 'name', 'kind'])
    if (typeof source.id !== 'string' || !/^(?:screen|window):[^\s]{1,180}$/.test(source.id) || typeof source.name !== 'string' || !source.name || source.name.length > 1000 || (source.kind !== 'window' && source.kind !== 'screen') || !source.id.startsWith(`${source.kind}:`)) throw new Error('请选择明确的屏幕或窗口。')
    current.capturing = true
    try {
      const image = await this.dependencies.capture({ id: source.id, name: source.name, kind: source.kind as 'window' | 'screen' })
      if (this.active(owner, id) !== current || !current.view.steps.includes(step)) throw new Error('记录或步骤已取消，画面未保留。')
      const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
      if (!(image.bytes instanceof Uint8Array) || image.bytes.length > MAX_IMAGE_BYTES || !pngSignature.every((byte, index) => image.bytes[index] === byte) || !/^data:image\/png;base64,/.test(image.previewDataUrl)) throw new Error('截图不可用或超过单张 8 MB 限制。')
      const total = [...current.images].reduce((bytes, [key, value]) => bytes + (key === step.id ? 0 : value.bytes.length), image.bytes.length)
      if (total > MAX_RECORDING_BYTES) throw new Error('截图总量超过 32 MB，请移除部分画面。')
      current.images.set(step.id, image)
      step.image = { previewDataUrl: image.previewDataUrl, width: image.width, height: image.height }
      return this.view(current)
    } finally { current.capturing = false }
  }
  stop(owner: number, id: unknown): SkillRecordingView {
    const current = this.active(owner, id)
    if (!current.view.steps.length) throw new Error('请至少记录一个包含操作和预期结果的步骤。')
    current.view.phase = 'review'
    current.view.markdown = buildMarkdown(current)
    return this.view(current)
  }
  save(owner: number, id: unknown, markdown: unknown, reviewed: unknown): SkillRecordingSaveResult {
    const current = this.require(owner, id)
    if (current.view.phase !== 'review' || reviewed !== true) throw new Error('请停止记录，并确认已检查技能正文和截图。')
    if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > 128 * 1024) throw new Error('技能草稿为空或超过 128 KB。')
    if (containsSensitiveText(markdown)) throw new Error('草稿包含疑似凭据，请移除或改为占位符后保存。')
    const images = current.view.steps.flatMap((step, index) => {
      const image = current.images.get(step.id)
      return image ? [{ filename: `step-${index + 1}.png`, bytes: image.bytes }] : []
    })
    const saved = this.dependencies.save(current.view.name, markdown, images)
    this.clearOwner(owner)
    return saved
  }
  cancel(owner: number, id: unknown): void {
    const current = this.recordings.get(owner)
    if (!current) return
    if (current.view.id !== id) throw new Error('记录身份不匹配。')
    this.clearOwner(owner)
  }
  clearOwner(owner: number): void {
    const current = this.recordings.get(owner)
    if (current) { current.images.clear(); current.view.steps = []; delete current.view.markdown }
    this.recordings.delete(owner)
  }
  private active(owner: number, id: unknown): Recording {
    const current = this.require(owner, id)
    if (current.view.phase !== 'recording') throw new Error('记录已经停止。')
    return current
  }
  private require(owner: number, id: unknown): Recording {
    const current = this.recordings.get(owner)
    if (!current || current.view.id !== id) throw new Error('记录不存在或不属于当前窗口。')
    if (this.now() - current.view.startedAt > 60 * 60_000) { this.clearOwner(owner); throw new Error('记录已超过一小时，请重新开始。') }
    return current
  }
  private step(current: Recording, id: unknown): SkillRecordingStep {
    const step = current.view.steps.find(value => value.id === id)
    if (!step) throw new Error('示范步骤不存在。')
    return step
  }
  private view(current: Recording): SkillRecordingView { return structuredClone(current.view) }
  private now(): number { return this.dependencies.now?.() ?? Date.now() }
}

function text(raw: unknown, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max || raw.includes('\0')) throw new Error(`请填写 1–${max} 字的有效内容。`)
  return redactSensitiveText(raw.trim())
}
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new Error('记录参数无效。')
  return raw as Record<string, unknown>
}
function buildMarkdown(recording: Recording): string {
  const { name, description, steps } = recording.view
  return ['---', `name: ${name}`, `description: ${JSON.stringify(description.replace(/\s+/g, ' '))}`, 'tags: [recorded, workflow]', '---', '',
    `# ${name}`, '', description, '', '## 执行步骤', ...steps.flatMap((step, index) => [
      `${index + 1}. ${step.action.replace(/\n/g, '\n   ')}`,
      ...(recording.images.has(step.id) ? [`   参考示范画面：[步骤 ${index + 1}](assets/step-${index + 1}.png)。`] : [])
    ]), '', '## 验证', ...steps.map((step, index) => `${index + 1}. ${step.outcome.replace(/\n/g, '\n   ')}`), '',
    '## 使用边界', '- 本技能来自用户逐步填写的示范；附图仅表示用户主动捕获的画面。执行时仍需检查当前界面和结果。',
    '- 根据当前任务范围取得文件、网络和电脑操作权限；录制与保存不代替后续执行授权。', ''].join('\n')
}
