#!/usr/bin/env node
/**
 * Deterministic local UI evidence for the global Runs/Review projections.
 *
 * The fixture is written through ProjectWorkspace/Supervisor production
 * boundaries into a disposable userData root. It contains no credentials and
 * the smoke disables real Provider execution. The renderer must read the
 * TaskRun-owned row and failed Acceptance row through the canonical IPC
 * methods, then carry each immutable identity into the project surface.
 */
import { runUiEvidenceGate } from './lib/ui-evidence-gate.mjs'

runUiEvidenceGate({
  kind: 'caogen.work-os-runs-review-ui-report',
  directory: 'work-os-runs-review-ui',
  fixture: 'runs-review',
  reportFixture: 'runs-review-canonical-local',
  label: 'work-os runs/review UI gate',
  validate(report, check) {
    const clicks = Array.isArray(report.clicks) ? report.clicks : []
    check('Runs row click evidence exists', clicks.some((item) => item.name === 'Runs row opens WorkItem' && item.workItemId === 'fixture-runs-review-run-item'))
    check('Review row click evidence exists', clicks.some((item) => item.name === 'Review row opens delivery' && item.workItemId === 'fixture-runs-review-review-item'))
  }
})
