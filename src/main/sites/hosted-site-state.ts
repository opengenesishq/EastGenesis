import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostedSiteAnalytics, HostedSiteDescriptor, HostedSitePreview, HostedSiteReceipt } from '../../shared/hosted-site-types'
import type { SiteDeploymentTarget } from '../../shared/site-deployment-types'
import { writeDurableFile } from '../durable-file'
import { hostedSiteKey, validateHostedDescriptor } from './hosted-site-protocol'

export interface HostedSavedPreview { view: HostedSitePreview; target: SiteDeploymentTarget; ownerKey: string; executableDigest: string; environmentDigest: string; authorityRevision: number; ownerWindow: number }
export interface HostedSavedReceipt { view: HostedSiteReceipt; preview: HostedSavedPreview; inspection?: { result: 'applied' | 'not_applied'; after?: HostedSiteDescriptor; checkedAt: number } }
export interface HostedBinding {
  sessionId: string; targetId: string; ownerKey: string; targetDigest: string; descriptor: HostedSiteDescriptor
  analytics?: HostedSiteAnalytics; previews: HostedSavedPreview[]; receipts: HostedSavedReceipt[]
}
export interface HostedDocument { version: 1; bindings: HostedBinding[] }
async function stateFile(root: string): Promise<string> {
  const directory = join(await realpath(root), 'hosted-sites')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('托管站点记录目录无效。')
  return join(directory, 'state.json')
}
export async function readHostedState(root: string): Promise<HostedDocument> {
  const file = await stateFile(root)
  let contents: string
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('托管站点记录大小或类型无效。'); contents = await readFile(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: [] }; throw error }
  const value = JSON.parse(contents) as HostedDocument
  if (value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 2000) throw new Error('托管站点记录格式无效。')
  for (const binding of value.bindings) {
    if (!binding || typeof binding.sessionId !== 'string' || typeof binding.targetId !== 'string' || typeof binding.ownerKey !== 'string' || !Array.isArray(binding.previews) || !Array.isArray(binding.receipts)) throw new Error('托管站点绑定格式无效。')
    binding.descriptor = validateHostedDescriptor(binding.descriptor)
  }
  return value
}
export async function writeHostedState(root: string, document: HostedDocument): Promise<void> {
  const contents = JSON.stringify(document)
  if (Buffer.byteLength(contents) > 32 * 1024 * 1024) throw new Error('托管站点记录达到本机容量限制；原记录保持保留。')
  await writeDurableFile(await stateFile(root), contents)
}
export async function assertHostedTargetMutable(root: string, sessionId: string, targetId: string): Promise<void> {
  const data = await readHostedState(root), binding = data.bindings.find(row => row.sessionId === sessionId && row.targetId === targetId)
  if (binding) assertHostedSiteMutable(data, binding.descriptor)
}
export function assertHostedSiteMutable(document: HostedDocument, site: HostedSiteDescriptor): void {
  const key = hostedSiteKey(site)
  if (document.bindings.some(binding => hostedSiteKey(binding.descriptor) === key && binding.receipts.some(row => ['executing', 'needs_reconciliation'].includes(row.view.status)))) throw new Error('该线上站点仍有执行或待核对变更；请先核对原操作。')
}
