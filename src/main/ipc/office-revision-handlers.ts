import { app, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { sessionManager } from '../sessionManager'
import { NativeToolRuntime } from '../native-tool-runtime'
import { officeDigest, officeRecord, officeText } from '../office-revision/input'
import { inspectScopedOffice, prepareOfficeRevision } from '../office-revision/plans'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

/** Read/plan only. Application must use the original Session model/tool/permission turn. */
export async function handleOfficeRevisionIpc(event: IpcMainInvokeEvent, action: unknown, input: unknown) {
  assertTrustedWorkflowLedgerSender(event)
  const raw = officeRecord(input, action === 'inspect'
    ? ['sessionId', 'artifactId', 'expectedDigest', 'locationId'] : ['sessionId', 'baseArtifactId', 'expectedDigest', 'operations'])
  const meta = sessionManager.get(officeText(raw.sessionId, 'sessionId'))?.meta
  if (!meta) throw new Error('Office检查需要当前仍可访问的任务会话。')
  const toolName = action === 'inspect' ? 'inspect_office_artifact' : 'plan_office_revision'
  const gate = new NativeToolRuntime(meta, () => undefined).preflightToolGate(toolName, raw, `office-inspect:${randomUUID()}`)
  if (!gate.allow) throw new Error(gate.message ?? 'Office检查已被当前会话权限拒绝。')
  const context = { meta, rootDir: app.getPath('userData') }
  if (action === 'inspect') return inspectScopedOffice(context, officeText(raw.artifactId, 'artifactId'), raw.expectedDigest === undefined ? undefined : officeDigest(raw.expectedDigest))
  if (action !== 'plan') throw new Error('Office revision action is invalid')
  return prepareOfficeRevision(context, { baseArtifactId: raw.baseArtifactId, expectedDigest: raw.expectedDigest, operations: raw.operations })
}
