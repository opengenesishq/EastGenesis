import type { HostedSiteEnvironmentInput, HostedSitePreview } from '../../shared/hosted-site-types'

export function validateHostedEnvironmentInput(input: unknown): HostedSiteEnvironmentInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('环境变量输入无效。')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['name', 'secret', 'value'].includes(key)) || typeof value.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.name)
    || typeof value.secret !== 'boolean' || typeof value.value !== 'string' || value.value.includes('\0') || Buffer.byteLength(value.value) > 8192) throw new Error('变量名须为字母、数字或下划线；值最多 8 KiB 且不能包含空字符。')
  return { name: value.name, secret: value.secret, value: value.value }
}

/** Values exist only between the explicit preview and its one execution. */
export class HostedEnvironmentValues {
  private values = new Map<string, { owner: number; reference: string; bytes: Buffer; timer: NodeJS.Timeout; expiresAt: number }>()
  retain(preview: HostedSitePreview, owner: number, value: string): void {
    if (preview.change.kind !== 'environment.set') throw new Error('变量预览类型无效。')
    this.remove(preview.id)
    const timer = setTimeout(() => this.remove(preview.id), Math.max(0, preview.expiresAt - Date.now())); timer.unref()
    this.values.set(preview.id, { owner, reference: preview.change.valueRef, bytes: Buffer.from(value), timer, expiresAt: preview.expiresAt })
  }
  read(preview: HostedSitePreview, owner: number): string {
    const item = this.values.get(preview.id)
    if (!item || item.owner !== owner || item.expiresAt <= Date.now() || preview.change.kind !== 'environment.set' || item.reference !== preview.change.valueRef) throw new Error('变量值已过期或窗口已变化，请重新输入并预览；不会使用空值继续。')
    return item.bytes.toString('utf8')
  }
  remove(id: string): void { const item = this.values.get(id); if (item) { clearTimeout(item.timer); item.bytes.fill(0); this.values.delete(id) } }
  clearOwner(owner: number): void { for (const [id, item] of this.values) if (item.owner === owner) this.remove(id) }
  dispose(): void { for (const id of this.values.keys()) this.remove(id) }
}
