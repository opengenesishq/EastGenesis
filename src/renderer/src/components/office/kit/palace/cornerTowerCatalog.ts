import type { PalacePoint } from './palaceWorldLayout'

export type CornerTowerId = 'tower_southeast' | 'tower_southwest' | 'tower_northeast' | 'tower_northwest'

export interface CornerTowerSpec {
  id: CornerTowerId
  /** Stable authored geometry anchor shared with the whitebox manifest. */
  anchor: string
  /** Stable functional role shared with functional-program.json. */
  role: 'ingress' | 'archive' | 'watch' | 'recovery'
  label: string
  purpose: string
  position: PalacePoint
  cameraPosition: PalacePoint
  cameraTarget: PalacePoint
  capabilities: string[]
}

export const CORNER_TOWERS: CornerTowerSpec[] = [
  { id: 'tower_southeast', anchor: 'TOWER_51.5_-62.5', role: 'ingress', label: '东南·接入楼', purpose: '目标输入、来源、身份和任务恢复', position: [51.5, 0, -62.5], cameraPosition: [58, 12, -48], cameraTarget: [51.5, 2, -62.5], capabilities: ['目标接入', '来源审查', '身份上下文', '任务恢复'] },
  { id: 'tower_southwest', anchor: 'TOWER_-51.5_-62.5', role: 'archive', label: '西南·档案楼', purpose: '产物、证据、验收和交付回执', position: [-51.5, 0, -62.5], cameraPosition: [-58, 12, -48], cameraTarget: [-51.5, 2, -62.5], capabilities: ['产物索引', '证据索引', '验收队列', '交付回执'] },
  { id: 'tower_northeast', anchor: 'TOWER_51.5_62.5', role: 'watch', label: '东北·巡核楼', purpose: 'Provider、模型、预算和运行异常', position: [51.5, 0, 62.5], cameraPosition: [58, 12, 48], cameraTarget: [51.5, 2, 62.5], capabilities: ['Provider 健康', '模型路由', '预算监控', '异常流'] },
  { id: 'tower_northwest', anchor: 'TOWER_-51.5_62.5', role: 'recovery', label: '西北·恢复楼', purpose: '对账、未知副作用、备份和人工接管', position: [-51.5, 0, 62.5], cameraPosition: [-58, 12, 48], cameraTarget: [-51.5, 2, 62.5], capabilities: ['对账', '恢复队列', '备份状态', '人工接管'] }
]
