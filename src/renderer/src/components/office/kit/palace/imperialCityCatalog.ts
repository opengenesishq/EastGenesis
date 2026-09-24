import type { SystemRoleSpec } from './systemRoleCatalog'
import type { PalacePoint } from './palaceWorldLayout'

export type ImperialCityZone = 'palace' | 'imperial' | 'offices'
export interface ImperialCityNode {
  id: string
  zone: Exclude<ImperialCityZone, 'palace'>
  label: string
  labelEn: string
  /** Work projections only. Coordinates never claim to locate a historical office. */
  roleIds: readonly string[]
  kind: 'service' | 'civil' | 'military'
}

export const IMPERIAL_CITY_ZONES = [
  { id: 'palace', label: '紫禁城', labelEn: 'Forbidden City' },
  { id: 'imperial', label: '皇城', labelEn: 'Imperial City' },
  { id: 'offices', label: '京师官署', labelEn: 'Capital offices' }
] as const

/** 1562–1566 reference. Imperial service nodes are functional waypoints, not
 * claims that the Transmission Office or inner-court offices occupied them. */
export const IMPERIAL_CITY_NODES: readonly ImperialCityNode[] = [
  { id: 'transmission', zone: 'imperial', label: '通传工作区', labelEn: 'Transmission courtyard', roleIds: ['tongzhengsi'], kind: 'service' },
  { id: 'attendants', zone: 'imperial', label: '内廷联络工作区', labelEn: 'Inner-court liaison', roleIds: ['silijian'], kind: 'service' },
  { id: 'personnel', zone: 'offices', label: '吏部', labelEn: 'Personnel', roleIds: ['libu'], kind: 'civil' },
  { id: 'revenue', zone: 'offices', label: '户部 · 国库账目', labelEn: 'Revenue · Treasury accounts', roleIds: ['hubu'], kind: 'civil' },
  { id: 'rites', zone: 'offices', label: '礼部', labelEn: 'Rites', roleIds: ['libu_ritual'], kind: 'civil' },
  { id: 'war', zone: 'offices', label: '兵部', labelEn: 'War', roleIds: ['bingbu'], kind: 'military' },
  { id: 'justice', zone: 'offices', label: '刑部', labelEn: 'Justice', roleIds: ['xingbu'], kind: 'civil' },
  { id: 'works', zone: 'offices', label: '工部', labelEn: 'Works', roleIds: ['gongbu'], kind: 'civil' },
  { id: 'oversight', zone: 'offices', label: '监察与审复', labelEn: 'Oversight and review', roleIds: ['duchayuan', 'liuke', 'dalisi'], kind: 'civil' },
  { id: 'military', zone: 'offices', label: '军务工作区', labelEn: 'Military affairs', roleIds: ['wujun_dudufu', 'tongbing_jiangling'], kind: 'military' },
  { id: 'learning', zone: 'offices', label: '文教与历算', labelEn: 'Learning and astronomy', roleIds: ['hanlinyuan', 'guozijian', 'taichangsi', 'qintianjian'], kind: 'civil' },
  { id: 'security', zone: 'offices', label: '侍卫与查核', labelEn: 'Guard and investigation', roleIds: ['jinyiwei', 'dongchang'], kind: 'military' }
]

export function imperialCityNodes(zone: ImperialCityZone, roles: readonly SystemRoleSpec[]): ImperialCityNode[] {
  const available = new Set(roles.map(role => role.id))
  return IMPERIAL_CITY_NODES.filter(node => node.zone === zone && node.roleIds.some(id => available.has(id)))
}

export function imperialCityNodeForRole(id: string): ImperialCityNode | undefined {
  return IMPERIAL_CITY_NODES.find(node => node.roleIds.includes(id))
}

export function imperialCityMapPosition(index: number, count: number): PalacePoint {
  const columns = Math.min(4, Math.max(1, count)), rows = Math.ceil(count / columns)
  return [(index % columns - (columns - 1) / 2) * 19, 0, (Math.floor(index / columns) - (rows - 1) / 2) * 17]
}

export function imperialCityCamera(zone: ImperialCityZone, entered: boolean): { position: PalacePoint; target: PalacePoint } {
  if (entered) return { position: [13.5, 12, 19], target: [0, 1, -1.8] }
  return zone === 'imperial'
    ? { position: [23, 29, 40], target: [0, 0, -3] }
    : { position: [47, 53, 66], target: [0, 0, 0] }
}
