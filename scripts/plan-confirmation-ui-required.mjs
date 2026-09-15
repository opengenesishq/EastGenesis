#!/usr/bin/env node
import { runUiEvidenceGate } from './lib/ui-evidence-gate.mjs'

runUiEvidenceGate({
  kind: 'caogen.plan-confirmation-ui-report',
  directory: 'plan-confirmation-ui',
  fixture: 'plan-confirmation',
  reportFixture: 'plan-confirmation-canonical-local',
  label: 'plan confirmation UI gate',
  validate(report, check) {
    const clicks = Array.isArray(report.clicks) ? report.clicks : []
    check('Run to pending TaskPlan click observed', clicks.some((item) => item.name === 'Run opens pending TaskPlan'))
    check('approve click observed', clicks.some((item) => item.name === 'TaskPlan approve'))
    check('revoke click observed', clicks.some((item) => item.name === 'TaskPlan revoke'))
  }
})
