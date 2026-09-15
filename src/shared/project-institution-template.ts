import type { WorkItemStatus } from './project-workspace-types'

/** Project institution identities are separate from agents and permission grants. */
export interface ProjectInstitutionTemplateRef {
  schemaVersion: 1
  templateId: 'cabinet-six-ministries' | 'legacy-compatible'
  templateVersion: 1
}

export interface ProjectInstitutionRole {
  id: string
  name: string
  nameEn: string
  duty: string
  dutyEn: string
  participation: 'user' | 'on_demand' | 'program' | 'legacy'
}

export interface ProjectInstitutionTemplate {
  ref: ProjectInstitutionTemplateRef
  name: string
  nameEn: string
  roles: readonly ProjectInstitutionRole[]
}

export const DEFAULT_PROJECT_INSTITUTION_TEMPLATE: Readonly<ProjectInstitutionTemplateRef> = Object.freeze({
  schemaVersion: 1, templateId: 'cabinet-six-ministries', templateVersion: 1
})
export const LEGACY_PROJECT_INSTITUTION_TEMPLATE: Readonly<ProjectInstitutionTemplateRef> = Object.freeze({
  schemaVersion: 1, templateId: 'legacy-compatible', templateVersion: 1
})

// Existing ministry IDs are deliberately reused. In particular, libu is 吏部,
// while libu_ritual is 礼部. Neither taizi nor xichang is renamed or reassigned.
const CABINET_ROLES: readonly ProjectInstitutionRole[] = [
  { id: 'huangdi', name: '皇帝', nameEn: 'Emperor', duty: '用户提出目标、授权、裁决、验收与接管', dutyEn: 'The user sets goals, grants access, decides, accepts and takes over', participation: 'user' },
  { id: 'neige', name: '内阁', nameEn: 'Cabinet', duty: '理解目标、制定计划、协调必要机构与汇总进展', dutyEn: 'Understand goals, plan, coordinate required institutions and report progress', participation: 'on_demand' },
  { id: 'libu', name: '吏部', nameEn: 'Ministry of Personnel', duty: '人员配置、能力档案、职责与分派候选', dutyEn: 'Manage agent profiles, capabilities, responsibilities and assignment candidates', participation: 'program' },
  { id: 'hubu', name: '户部', nameEn: 'Ministry of Revenue', duty: '预算、费用、资源额度与成本分析', dutyEn: 'Track budgets, costs and resource quotas', participation: 'program' },
  { id: 'libu_ritual', name: '礼部', nameEn: 'Ministry of Rites', duty: '文档、内容、设计、汇报和对外呈现', dutyEn: 'Create documents, content, design and presentations', participation: 'on_demand' },
  { id: 'bingbu', name: '兵部', nameEn: 'Ministry of War', duty: '执行资源协调、自动化运行安排', dutyEn: 'Coordinate execution resources and automated runs', participation: 'program' },
  { id: 'xingbu', name: '刑部', nameEn: 'Ministry of Justice', duty: '规则、权限边界与失败处置建议', dutyEn: 'Check rules and permission boundaries and suggest failure handling', participation: 'program' },
  { id: 'gongbu', name: '工部', nameEn: 'Ministry of Works', duty: '软件工程、工具构建、模型制作与维护', dutyEn: 'Build and maintain software, tools and models', participation: 'on_demand' },
  { id: 'duchayuan', name: '都察院', nameEn: 'Censorate', duty: '执行监察与异常跟踪', dutyEn: 'Inspect execution and track anomalies', participation: 'program' },
  { id: 'liuke', name: '六科', nameEn: 'Six Offices of Scrutiny', duty: '原始记录与证据完整性检查', dutyEn: 'Check original records and evidence completeness', participation: 'program' },
  { id: 'dalisi', name: '大理寺', nameEn: 'Court of Review', duty: '争议、验收与恢复方案复核；按需组织司法审复', dutyEn: 'Review disputes, acceptance and recovery proposals with relevant reviewers', participation: 'on_demand' },
  { id: 'wujun_dudufu', name: '五军都督府', nameEn: 'Chief Military Commissions', duty: '执行器资源池、运行环境与队列', dutyEn: 'Manage executor pools, environments and queues', participation: 'program' },
  { id: 'tongbing_jiangling', name: '统兵将领', nameEn: 'Commanders', duty: '运行实例与执行资源状态', dutyEn: 'Represent execution instances and resource status', participation: 'program' },
  { id: 'tongzhengsi', name: '通政使司', nameEn: 'Transmission Office', duty: '收件、指令、任务传达与通知', dutyEn: 'Route incoming requests, instructions and notifications', participation: 'program' },
  { id: 'hanlinyuan', name: '翰林院', nameEn: 'Hanlin Academy', duty: '深度研究、知识整理与专业文稿', dutyEn: 'Research, organize knowledge and prepare specialist writing', participation: 'on_demand' },
  { id: 'guozijian', name: '国子监', nameEn: 'Imperial Academy', duty: '知识库、操作指南、模板与示例管理', dutyEn: 'Manage knowledge, guides, templates and examples', participation: 'program' },
  { id: 'taichangsi', name: '太常寺', nameEn: 'Court of Ceremonies', duty: '重复流程模板与检查项', dutyEn: 'Maintain recurring workflow templates and checklists', participation: 'program' },
  { id: 'qintianjian', name: '钦天监', nameEn: 'Astronomical Bureau', duty: '时间安排、监测、计算与数据分析', dutyEn: 'Schedule, monitor, calculate and analyze data', participation: 'on_demand' },
  { id: 'jinyiwei', name: '锦衣卫', nameEn: 'Embroidered Uniform Guard', duty: '授权范围内的安全事件调查', dutyEn: 'Investigate security incidents within granted permissions', participation: 'on_demand' },
  { id: 'dongchang', name: '东厂', nameEn: 'Eastern Depot', duty: '授权范围内的工具与敏感数据边界调查', dutyEn: 'Investigate tool and sensitive data boundaries within granted permissions', participation: 'on_demand' },
  { id: 'silijian', name: '司礼监等内廷', nameEn: 'Inner Court', duty: '批示、审批待办和交付回执；由用户决定授权与验收', dutyEn: 'Organize instructions, pending approvals and receipts for user decisions', participation: 'program' }
]

const LEGACY_NAMES = [
  ['taizi', '太子', 'Crown Prince'], ['neige', '内阁', 'Cabinet'],
  ['dongchang', '东厂', 'Eastern Depot'], ['xichang', '西厂', 'Western Depot'],
  ['libu', '吏部', 'Ministry of Personnel'], ['hubu', '户部', 'Ministry of Revenue'],
  ['libu_ritual', '礼部', 'Ministry of Rites'], ['bingbu', '兵部', 'Ministry of War'],
  ['xingbu', '刑部', 'Ministry of Justice'], ['gongbu', '工部', 'Ministry of Works']
] as const

const TEMPLATES: Record<ProjectInstitutionTemplateRef['templateId'], ProjectInstitutionTemplate> = {
  'cabinet-six-ministries': {
    ref: DEFAULT_PROJECT_INSTITUTION_TEMPLATE,
    name: '皇帝、内阁、六部及相关机构', nameEn: 'Emperor, Cabinet, Six Ministries and related institutions', roles: CABINET_ROLES
  },
  'legacy-compatible': {
    ref: LEGACY_PROJECT_INSTITUTION_TEMPLATE,
    name: '旧机构兼容（历史配置优先）', nameEn: 'Legacy institutions (existing configuration preserved)',
    roles: LEGACY_NAMES.map(([id, name, nameEn]) => ({
      id, name, nameEn, duty: '继续使用原有职责、身份、权限与分派记录',
      dutyEn: 'Keep existing responsibilities, identities, permissions and assignments', participation: 'legacy'
    }))
  }
}
for (const template of Object.values(TEMPLATES)) {
  template.roles.forEach(Object.freeze)
  Object.freeze(template.roles)
  Object.freeze(template)
}

export function isProjectInstitutionTemplateRef(value: unknown): value is ProjectInstitutionTemplateRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<ProjectInstitutionTemplateRef>
  return ref.schemaVersion === 1 && ref.templateVersion === 1 &&
    (ref.templateId === 'cabinet-six-ministries' || ref.templateId === 'legacy-compatible') &&
    Object.keys(value).every((key) => ['schemaVersion', 'templateId', 'templateVersion'].includes(key))
}

/** Reading an old project never applies new defaults or writes a migration. */
export function projectInstitutionTemplate(ref?: ProjectInstitutionTemplateRef): ProjectInstitutionTemplate {
  if (ref !== undefined && !isProjectInstitutionTemplateRef(ref)) throw new Error('Unsupported project institution template')
  return TEMPLATES[(ref ?? LEGACY_PROJECT_INSTITUTION_TEMPLATE).templateId]
}

export interface ProjectInstitutionMigrationPreview {
  current: ProjectInstitutionTemplate
  target: ProjectInstitutionTemplate
  added: readonly ProjectInstitutionRole[]
  retained: readonly ProjectInstitutionRole[]
  legacyOnly: readonly ProjectInstitutionRole[]
  pendingWorkCount: number
  recordedWorkCount: number
}

/** Describes differences only. It cannot rename roles, grant permissions or dispatch work. */
export function previewProjectInstitutionMigration(input: {
  institutionTemplate?: ProjectInstitutionTemplateRef
  target: ProjectInstitutionTemplateRef
  workItems: readonly { status: WorkItemStatus }[]
}): ProjectInstitutionMigrationPreview {
  const current = projectInstitutionTemplate(input.institutionTemplate)
  const target = projectInstitutionTemplate(input.target)
  const currentIds = new Set(current.roles.map((role) => role.id))
  const targetIds = new Set(target.roles.map((role) => role.id))
  return {
    current, target,
    added: target.roles.filter((role) => !currentIds.has(role.id)),
    retained: current.roles.filter((role) => targetIds.has(role.id)),
    legacyOnly: current.roles.filter((role) => !targetIds.has(role.id)),
    pendingWorkCount: input.workItems.filter((item) => !['done', 'failed', 'cancelled'].includes(item.status)).length,
    recordedWorkCount: input.workItems.length
  }
}
