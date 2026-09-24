import assert from 'node:assert/strict'
import { DEFAULT_PROJECT_INSTITUTION_TEMPLATE, LEGACY_PROJECT_INSTITUTION_TEMPLATE } from '../src/shared/project-institution-template'
import { systemRolesForTemplate } from '../src/renderer/src/components/office/kit/palace/systemRoleCatalog'
import { IMPERIAL_CITY_NODES, imperialCityCamera, imperialCityMapPosition, imperialCityNodeForRole, imperialCityNodes } from '../src/renderer/src/components/office/kit/palace/imperialCityCatalog'
import { imperialCityCourierFrame } from '../src/renderer/src/components/office/kit/palace/imperialCityMotion'

const roles = systemRolesForTemplate(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
assert.equal(imperialCityNodes('imperial', roles).length, 2)
assert.equal(imperialCityNodes('offices', roles).length, 10)
for (const id of ['libu', 'hubu', 'libu_ritual', 'bingbu', 'xingbu', 'gongbu']) assert.equal(imperialCityNodeForRole(id)?.zone, 'offices')
assert.equal(imperialCityNodeForRole('xichang'), undefined)
assert.equal(imperialCityNodes('imperial', systemRolesForTemplate(LEGACY_PROJECT_INSTITUTION_TEMPLATE)).length, 0)
assert.deepEqual(imperialCityNodes('offices', []), [])
for (const node of IMPERIAL_CITY_NODES) for (const id of node.roleIds) assert.ok(roles.some(role => role.id === id))
assert.ok(roles.find(role => role.id === 'hubu')?.actions.some(action => action.target === 'treasury'))
console.log('PASS district separation, canonical roles, legacy filtering and treasury routing')

const positions = imperialCityNodes('offices', roles).map((_, index, nodes) => imperialCityMapPosition(index, nodes.length))
assert.equal(new Set(positions.map(point => point.join(','))).size, positions.length)
assert.notDeepEqual(imperialCityCamera('offices', false), imperialCityCamera('offices', true))
console.log('PASS distinct courtyard locations and entry camera')

for (const index of [0, 1]) {
  let previous = imperialCityCourierFrame(0, index)
  let distance = 0
  for (let step = 1; step <= 2400; step++) {
    const current = imperialCityCourierFrame(step / 100, index)
    const movement = Math.hypot(current.x - previous.x, current.z - previous.z)
    assert.ok(movement < 0.012, 'courier never teleports at phase boundaries')
    assert.ok(Math.abs(current.x) >= 6 && Math.abs(current.z) <= 4.5, 'courier stays on clear side lanes')
    distance += movement; previous = current
  }
  assert.ok(distance > 17.9 && distance < 18.1)
}
assert.deepEqual(imperialCityCourierFrame(8.5, 0), imperialCityCourierFrame(11.5, 0))
console.log('PASS visible movement, bounded lanes, working stops and continuous loops')
