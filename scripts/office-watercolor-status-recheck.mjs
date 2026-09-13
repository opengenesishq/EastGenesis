#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), 'utf8')
const roles = ['researcher', 'planner', 'writer', 'designer', 'developer', 'review-test', 'operations']
const office = read('src/renderer/src/components/office/OfficeView.tsx')
const bootScene = read('src/renderer/src/components/office/OfficeBootScene.tsx')
const workstation = read('src/renderer/src/components/office/kit/ming-characters/MingWorkstation.tsx')
const mingRig = read('src/renderer/src/components/office/kit/ming-characters/MingCharacterRig.tsx')
const figureParts = read('src/renderer/src/components/office/kit/ming-characters/MingFigureParts.tsx')
const walkers = read('src/renderer/src/components/office/kit/AgentWalkers.tsx')
const walkerAnimation = read('src/renderer/src/components/office/kit/WalkerRigAnimation.ts')

assert(bootScene.includes("import MingCharacterRig from './kit/ming-characters/MingCharacterRig'") && bootScene.includes('<MingCharacterRig'), 'Office boot must use the approved Ming worker visual')
assert(office.includes('data-office-articulated-characters={visibleIds.length}'), 'Office must expose the articulated character count')
assert(office.includes('data-office-grounded-character-rigs={visibleIds.length}'), 'Office must expose the grounded character count')
assert(office.includes('data-office-low-poly-digital-workers={visibleIds.length}'), 'Office must expose the low-poly worker count')
assert(office.includes('data-office-camera-facing-character-sprites={0}'), 'Office must expose zero camera-facing character sprites')
assert(office.includes("import WorkstationPro from './kit/ming-characters/MingWorkstation'"), 'desk workers must use the approved Ming workstation')
assert(workstation.includes('<MingCharacterRig') && workstation.includes('seated working'), 'desk workers must render the Ming seated worker and real activity')
assert(walkers.includes('MingCharacterRig') && walkers.includes('animateWalkerRig('), 'walking workers must use the Ming rig driver')
assert(mingRig.includes('MingHead') && mingRig.includes('MingSleeve') && mingRig.includes('MingLeg'), 'Ming worker must retain a human-proportion articulated hierarchy')
assert(mingRig.includes('officeDigitalWorkerCharacter: true') && mingRig.includes('mingOriginalGeometry: true'), 'Ming worker must expose its runtime identity and original geometry')
assert(figureParts.includes('MING_ROBES'), 'Ming worker roles must retain stable authored costume accents')
assert(walkerAnimation.includes('applyWalking(refs, clock') && walkerAnimation.includes('walkFootTargets'), 'walking workers must pass both ground targets into gait IK')

for (const role of roles) assert(figureParts.includes(`${role}:`) || figureParts.includes(`'${role}':`), `Ming role accent is missing: ${role}`)
for (const [label, source] of [['OfficeView', office], ['WorkstationPro', workstation], ['AgentWalkers', walkers]]) {
  assert(!source.includes('<WatercolorCharacterRig'), `${label} must not render a camera-facing paper Sprite`)
}

console.log('office character status recheck: PASS (approved Ming rigs, grounded character geometry, zero Office sprites)')
