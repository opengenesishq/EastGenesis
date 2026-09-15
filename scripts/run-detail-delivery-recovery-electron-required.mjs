#!/usr/bin/env node
/**
 * V2-014 local Electron evidence for the canonical Run -> Acceptance ->
 * Recovery -> Delivery path. The nested smoke uses a disposable fixture and
 * disables Provider execution; this gate only promotes observed clicks and
 * fail-closed state, never human or production evidence.
 */
import { runUiEvidenceGate } from './lib/ui-evidence-gate.mjs'

const required = [
  'Work Inbox row opens Run detail',
  'Run detail opens Acceptance',
  'Run detail recovery completed',
  'Run detail opens delivery'
]

runUiEvidenceGate({
  kind: 'caogen.v2-014.run-detail-delivery-recovery-electron-report',
  directory: 'v2-014-run-detail-delivery-recovery',
  fixture: 'run-detail-delivery',
  reportFixture: 'runs-review-canonical-local',
  label: 'V2-014 Run detail -> Acceptance -> Recovery -> Delivery Electron gate',
  limitations: [
    'local disposable Electron fixture only',
    'does not prove a real Provider call or failover',
    'does not prove human timed acceptance or release packaging'
  ],
  validate(nestedReport, check, report) {
    const clicks = Array.isArray(nestedReport.clicks) ? nestedReport.clicks : []
    for (const name of required) {
      check(`observed click: ${name}`, clicks.some((click) => click.name === name))
    }
    report.observedClicks = required
  }
})
