#!/usr/bin/env node
import { runUiEvidenceGate } from './lib/ui-evidence-gate.mjs'

runUiEvidenceGate({
  kind: 'caogen.mission-compile-ui-report',
  directory: 'mission-compile-ui',
  fixture: 'mission-compile',
  reportFixture: 'runs-review-canonical-local',
  label: 'Mission compilation UI gate',
  limitations: ['local disposable Electron fixture', 'no Provider execution or human timed evidence'],
  validate(report, check) {
    const sessionIds = []
    for (const name of ['Goal starter opens compiled Mission plan', 'Mission plan approval projects four WorkItems']) {
      const click = report.clicks?.find((click) => click.name === name && click.sessionId)
      check(`click: ${name}`, Boolean(click))
      sessionIds.push(click.sessionId)
    }
    check('compile and approval refer to the same Session', sessionIds[0] === sessionIds[1] && report.missionCompilation?.sessionId === sessionIds[0])
    check('canonical approval readback is present', report.missionCompilation?.approvalStatus === 'approved' && report.missionCompilation?.projection?.steps?.length === 4)
    check('edited form version is the approved version', Boolean(report.missionCompilation?.editedVersionId) && report.missionCompilation.editedVersionId === report.missionCompilation.versionId && report.missionCompilation.originalVersionId !== report.missionCompilation.editedVersionId)
  }
})
