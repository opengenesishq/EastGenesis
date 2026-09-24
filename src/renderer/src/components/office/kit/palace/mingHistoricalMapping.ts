/** Read-only historical labels. These never change task identities, grants or template versions. */
export const MING_HISTORICAL_SOURCES = {
  buildings: { title: '故宫博物院 · 建筑', titleEn: 'Palace Museum · Architecture', url: 'https://www.dpm.org.cn/explore/buildings.html' },
  taihe: { title: '故宫博物院 · 太和殿', titleEn: 'Palace Museum · Hall of Supreme Harmony', url: 'https://www.dpm.org.cn/explore/building/236465.html' },
  zhonghe: { title: '故宫博物院 · 中和殿', titleEn: 'Palace Museum · Hall of Central Harmony', url: 'https://www.dpm.org.cn/explore/building/236464.html' },
  baohe: { title: '故宫博物院 · 保和殿', titleEn: 'Palace Museum · Hall of Preserving Harmony', url: 'https://www.dpm.org.cn/explore/building/236434.html' },
  offices1: { title: '《明史》卷七十二 · 职官一', titleEn: 'History of Ming, vol. 72 · Offices I', url: 'https://zh.wikisource.org/wiki/明史/卷72' },
  offices2: { title: '《明史》卷七十三 · 职官二', titleEn: 'History of Ming, vol. 73 · Offices II', url: 'https://zh.wikisource.org/wiki/明史/卷73' },
  offices3: { title: '《明史》卷七十四 · 职官三', titleEn: 'History of Ming, vol. 74 · Offices III', url: 'https://zh.wikisource.org/wiki/明史/卷74' },
  military: { title: '《明史》卷七十六 · 职官五', titleEn: 'History of Ming, vol. 76 · Military offices', url: 'https://zh.wikisource.org/wiki/明史/卷76' },
  justice: { title: '《明史》卷九十四 · 刑法二', titleEn: 'History of Ming, vol. 94 · Judicial institutions', url: 'https://zh.wikisource.org/wiki/明史/卷94' },
  depots: { title: '《明史》卷九十五 · 刑法三', titleEn: 'History of Ming, vol. 95 · Depots and guards', url: 'https://zh.wikisource.org/wiki/明史/卷95' },
  dress: { title: '《明史》卷六十七 · 舆服三', titleEn: 'History of Ming, vol. 67 · Official dress', url: 'https://zh.wikisource.org/wiki/明史/卷67' }
} as const

export type MingHistoricalSourceId = keyof typeof MING_HISTORICAL_SOURCES

export const MING_SCENE_REFERENCE = Object.freeze({
  period: '明嘉靖后期（1562—1566）',
  periodEn: 'Late Jiajing era, Ming dynasty (1562–1566)',
  description: '殿名以嘉靖改名后的皇极殿、中极殿、建极殿为准；今称太和殿、中和殿、保和殿。',
  descriptionEn: 'Use the Ming names Huangji, Zhongji and Jianji; today these halls are known as Taihe, Zhonghe and Baohe.',
  layout: '布局参考外朝、内廷分区。机构总览中的席位是工作入口，不表示六部衙署都设在宫内。',
  layoutEn: 'The layout takes the outer and inner court divisions as a reference. Institution seats are work shortcuts, not the historical locations of ministry offices.',
  assets: '现有人物与建筑为工作场景示意；服饰、陈设和建筑构件仍需逐项核对，不标作精确复原。',
  assetsEn: 'Current figures and buildings illustrate the workspace. Costumes, furnishings and building details are not yet a verified reconstruction.',
  attire: '人物按身份、品级和场合区分服饰；随侍属于内廷服务身份，不能默认画成东厂或西厂人员。',
  attireEn: 'Dress follows role, rank and occasion. A palace attendant is not automatically a member of either depot.',
  sourceIds: ['taihe', 'zhonghe', 'baohe', 'buildings', 'dress', 'offices3'] as readonly MingHistoricalSourceId[]
})

export interface MingHistoricalRole {
  readonly id: string
  readonly historicalDuty: string
  readonly historicalDutyEn: string
  readonly productMapping: string
  readonly productMappingEn: string
  readonly note?: string
  readonly noteEn?: string
  readonly sourceIds: readonly MingHistoricalSourceId[]
}

const roles: readonly MingHistoricalRole[] = [
  { id: 'huangdi', historicalDuty: '皇帝掌握最高裁决权，内阁票拟与诸司奏议仍须经皇帝裁决。', historicalDutyEn: 'The emperor held final authority over cabinet drafts and official memorials.', productMapping: '用户提出目标、授权、裁决、验收与接管。', productMappingEn: 'The user sets goals, authorizes actions, decides, accepts and takes over.', sourceIds: ['offices1', 'offices3'] },
  { id: 'neige', historicalDuty: '大学士备顾问、审阅章奏、票拟批答；明代内阁不是现代内阁政府。', historicalDutyEn: 'Grand secretaries advised the emperor, reviewed memorials and drafted responses; this was not a modern cabinet government.', productMapping: '理解目标、拟定计划、协调必要工作并汇报。', productMappingEn: 'Interpret goals, propose plans, coordinate required work and report progress.', sourceIds: ['offices1'] },
  { id: 'libu', historicalDuty: '吏部掌官吏选授、封勋与考课。', historicalDutyEn: 'The Ministry of Personnel managed appointments, honors and official evaluations.', productMapping: '人员、能力档案与分派候选。', productMappingEn: 'Agent profiles, capabilities and assignment candidates.', sourceIds: ['offices1'] },
  { id: 'hubu', historicalDuty: '户部掌户口、田赋及钱粮政令，所属有太仓银库；内承运库属于大内库藏。', historicalDutyEn: 'The Ministry of Revenue administered population, taxation and state finance, including the Taicang silver treasury. The Inner Treasury was a separate palace institution.', productMapping: '国库展示各厂商、模型的已记录用量、费用、预算与额度。', productMappingEn: 'The treasury shows recorded provider and model usage, costs, budgets and quotas.', note: '国库是账目功能名称，不把户部国库与皇帝内库合并成一座史实库房。', noteEn: 'Treasury is the accounting view; it does not merge state and palace treasuries into one historical building.', sourceIds: ['offices1', 'offices3'] },
  { id: 'libu_ritual', historicalDuty: '礼部掌礼仪、祭祀、宴飨与贡举等事务。', historicalDutyEn: 'The Ministry of Rites oversaw ceremonies, sacrifices, state banquets and examinations.', productMapping: '文稿、汇报与对外呈现的产品分工。', productMappingEn: 'A product assignment for documents, reports and presentation.', note: '内容制作属于软件类比；礼部不负责国库财政。', noteEn: 'Content production is a software analogy. The ministry did not administer state treasury finance.', sourceIds: ['offices1'] },
  { id: 'bingbu', historicalDuty: '兵部掌武选、军政、军令等事务，与都督府、统兵将领分职。', historicalDutyEn: 'The Ministry of War administered military appointments and affairs, with duties distinct from military commissions and field commanders.', productMapping: '执行资源协调与自动化运行安排。', productMappingEn: 'Coordinate execution resources and scheduled work.', sourceIds: ['offices1', 'military'] },
  { id: 'xingbu', historicalDuty: '刑部掌刑名，与都察院、大理寺构成司法审理、纠察和复核分工。', historicalDutyEn: 'The Ministry of Justice handled criminal cases alongside censorial oversight and judicial review.', productMapping: '规则、权限边界与失败处置建议。', productMappingEn: 'Rules, permission boundaries and proposed failure handling.', sourceIds: ['offices1', 'justice'] },
  { id: 'gongbu', historicalDuty: '工部掌营造、工程及相关物料、制造事务。', historicalDutyEn: 'The Ministry of Works administered construction, engineering, materials and manufacture.', productMapping: '软件工程、工具和模型的制作维护。', productMappingEn: 'Build and maintain software, tools and models.', sourceIds: ['offices1'] },
  { id: 'duchayuan', historicalDuty: '都察院掌纠劾官邪、监察百司等事务。', historicalDutyEn: 'The Censorate inspected officials and censured misconduct.', productMapping: '执行监察与异常跟踪。', productMappingEn: 'Execution oversight and incident tracking.', sourceIds: ['offices2'] },
  { id: 'liuke', historicalDuty: '六科给事中分科稽察、封驳与规谏，不是六部的办事人员统称。', historicalDutyEn: 'The Six Offices of Scrutiny reviewed affairs, remonstrated and returned improper orders; they were distinct from ministry staff.', productMapping: '原始记录与证据完整性检查。', productMappingEn: 'Check original records and evidence completeness.', sourceIds: ['offices3'] },
  { id: 'dalisi', historicalDuty: '大理寺掌审谳平反，复核案件并驳正不当拟断。', historicalDutyEn: 'The Court of Review re-examined cases and corrected improper judgments.', productMapping: '争议、验收和恢复方案的复核。', productMappingEn: 'Review disputes, acceptance and recovery proposals.', sourceIds: ['offices2', 'justice'] },
  { id: 'wujun_dudufu', historicalDuty: '五军都督府分领都司、卫所等军务，与兵部各有职掌。', historicalDutyEn: 'The Five Chief Military Commissions administered their military commands and guards, with responsibilities distinct from the Ministry of War.', productMapping: '执行器资源池、运行环境与队列。', productMappingEn: 'Executor pools, environments and queues.', sourceIds: ['military'] },
  { id: 'tongbing_jiangling', historicalDuty: '统兵将领按授命领兵；“统兵将领”是角色类别，不是一座固定衙署名称。', historicalDutyEn: 'Commanders led forces under assigned commissions; this is a role category rather than the name of a single office.', productMapping: '运行实例与执行资源状态。', productMappingEn: 'Execution instances and resource status.', sourceIds: ['military'] },
  { id: 'tongzhengsi', historicalDuty: '通政使司受理内外章疏，登记、敷奏与封驳。', historicalDutyEn: 'The Office of Transmission received, registered and presented memorials and returned improper submissions.', productMapping: '收件、任务传达与通知。', productMappingEn: 'Incoming requests, task dispatch and notifications.', sourceIds: ['offices2'] },
  { id: 'hanlinyuan', historicalDuty: '翰林院掌制诰、史册、文翰，并备顾问、参与讲读。', historicalDutyEn: 'The Hanlin Academy prepared edicts, histories and official writing, and provided advice and instruction.', productMapping: '研究、知识整理与专业文稿。', productMappingEn: 'Research, knowledge organization and specialist writing.', sourceIds: ['offices2'] },
  { id: 'guozijian', historicalDuty: '国子监掌国学诸生的训导和教学。', historicalDutyEn: 'The Imperial Academy educated and supervised its students.', productMapping: '知识库、操作指南、模板与示例。', productMappingEn: 'Knowledge, guides, templates and examples.', sourceIds: ['offices2'] },
  { id: 'taichangsi', historicalDuty: '太常寺掌祭祀礼乐，听于礼部。', historicalDutyEn: 'The Court of Imperial Sacrifices managed sacrificial rites and music under the Ministry of Rites.', productMapping: '重复流程模板与检查项。', productMappingEn: 'Recurring workflow templates and checklists.', sourceIds: ['offices3'] },
  { id: 'qintianjian', historicalDuty: '钦天监掌观测天象、历法与授时等事务。', historicalDutyEn: 'The Astronomical Bureau observed celestial phenomena, maintained the calendar and kept time.', productMapping: '时间安排、监测、计算与数据分析。', productMappingEn: 'Scheduling, monitoring, calculation and data analysis.', sourceIds: ['offices3'] },
  { id: 'jinyiwei', historicalDuty: '锦衣卫属于亲军，兼有侍卫、仪仗与侦缉等职掌；不等同于宦官机构。', historicalDutyEn: 'The Embroidered Uniform Guard was an imperial military guard with protective, ceremonial and investigative duties, not a eunuch office.', productMapping: '授权范围内的安全事件调查。', productMappingEn: 'Security investigations within granted permissions.', sourceIds: ['military', 'depots'] },
  { id: 'dongchang', historicalDuty: '东厂由内臣提督，承担侦缉；厂役与锦衣卫有关，不是所有宦官的统称。', historicalDutyEn: 'The Eastern Depot was directed by a palace eunuch and performed investigations, using personnel connected to the imperial guard. It did not represent all eunuchs.', productMapping: '授权范围内的工具与敏感数据边界调查。', productMappingEn: 'Investigate tool and sensitive data boundaries within granted permissions.', sourceIds: ['depots'] },
  { id: 'silijian', historicalDuty: '司礼监掌印、秉笔等各有职掌；秉笔、随堂照阁票批朱。内廷另有诸监司局，不能全部视为司礼监。', historicalDutyEn: 'The Directorate of Ceremonial had distinct seal-keeping and drafting offices. Other inner-court directorates and bureaus remained separate.', productMapping: '整理批示、审批待办与交付回执，决定仍由用户作出。', productMappingEn: 'Organize instructions, approvals and delivery receipts; the user makes decisions.', sourceIds: ['offices3'] },
  { id: 'companion', historicalDuty: '随侍是内廷侍从身份，不能仅凭宦官身份认定其属于东厂或西厂。', historicalDutyEn: 'A palace attendant is a service role; eunuch status alone does not imply membership in either depot.', productMapping: '任务提醒、快捷输入、继续工作与故宫导航。', productMappingEn: 'Task reminders, quick input, continuation and palace navigation.', sourceIds: ['offices3', 'depots'] },
  { id: 'taizi', historicalDuty: '太子是皇位继承身份，不能自动视为日常最高裁决者或内阁首脑。', historicalDutyEn: 'The crown prince was the designated heir, not automatically the daily final authority or head of the cabinet.', productMapping: '保留旧任务中已记录的太子身份和授权。', productMappingEn: 'Preserve the recorded identity and authorization in legacy tasks.', note: '旧模板兼容身份，不据此重写新模板或历史任务。', noteEn: 'A legacy identity; it does not rewrite new templates or past tasks.', sourceIds: ['offices1', 'offices2'] },
  { id: 'xichang', historicalDuty: '西厂在成化、正德部分时期设置并废止，不是明代全期常设机构；嘉靖参考场景不将其列为在设衙署。', historicalDutyEn: 'The Western Depot existed during parts of the Chenghua and Zhengde eras and was abolished. It was not a standing institution in the Jiajing reference scene.', productMapping: '仅为旧配置保留原有身份与记录。', productMappingEn: 'Retain its original identity and records only for legacy configurations.', sourceIds: ['depots'] }
]

const rolesById: ReadonlyMap<string, MingHistoricalRole> = new Map(roles.map(role => [role.id, Object.freeze(role)]))

export function mingHistoricalRoleById(roleId: string): MingHistoricalRole | undefined {
  return rolesById.get(roleId)
}

export function mingHistoricalSourcesFor(roleId?: string) {
  const ids = roleId ? mingHistoricalRoleById(roleId)?.sourceIds ?? [] : MING_SCENE_REFERENCE.sourceIds
  return ids.map(id => ({ id, ...MING_HISTORICAL_SOURCES[id] }))
}
