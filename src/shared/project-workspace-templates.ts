import type { ProjectWorkspaceKind, ProjectWorkspaceTemplateDefinition } from './project-workspace-types'

const LOCAL_RESOURCE = {
  kind: 'directory' as const,
  label: '本地工作目录',
  dataClass: 'S2' as const,
  egressPolicy: 'local_only' as const,
  reason: '按需关联项目文件；模板不会自动读取或外发任何目录。'
}

const TEMPLATES: Record<ProjectWorkspaceKind, ProjectWorkspaceTemplateDefinition> = {
  personal: template('personal', '个人事务', '把零散事项变成可追踪、可验收的个人工作流', {
    title: '完成本期个人目标',
    objective: '整理输入、完成最高优先事项并留下可复查结果。',
    constraints: ['保持任务数量最少', '涉及外部发送或删除时必须单独确认'],
    successCriteria: ['优先事项有明确结果', '未完成项有负责人或下一步'],
    forbiddenActions: ['未经确认代表用户对外承诺'],
    riskLevel: 'low',
    acceptance: ['交付结果可定位', '遗留事项和风险已列明']
  }, [
    work('triage', 'analysis', '整理与排序', '汇总输入并选出本期真正需要完成的事项。', [], ['report'], ['优先级和取舍理由清晰']),
    work('execute', 'operations', '完成最高优先事项', '执行已确认的首要事项并保留过程证据。', ['triage'], ['custom'], ['结果与原目标一致']),
    work('review', 'review', '复查与收口', '复核结果、风险和下一步。', ['execute'], ['report'], ['结果可复查且无未披露阻塞'])
  ], [LOCAL_RESOURCE]),
  office: template('office', '办公交付', '从资料整理到可打开的 Word、Excel、PPT 或 PDF 成品', {
    title: '交付办公成品',
    objective: '基于受控输入生成、复核并交付可直接使用的办公文件。',
    constraints: ['保留原文件', '导出前完成内容和视觉复核'],
    successCriteria: ['成品可打开', '关键数字和引用可追溯', '版式适合目标场景'],
    forbiddenActions: ['覆盖未经备份的原文件'],
    riskLevel: 'medium',
    acceptance: ['文件格式正确且可打开', '内容与视觉检查均有证据']
  }, [
    work('source', 'analysis', '整理资料与口径', '确认输入文件、受众、口径和输出格式。', [], ['report'], ['输入范围与缺失项明确']),
    work('draft', 'writing', '制作办公成品', '生成所需文档、表格、演示或 PDF。', ['source'], ['document', 'spreadsheet', 'presentation', 'pdf'], ['成品内容完整且保留来源']),
    work('qa', 'review', '内容与视觉复核', '检查数据、引用、分页、裁切、字体和导出结果。', ['draft'], ['screenshot', 'test_report'], ['无内容错误和明显版式缺陷'])
  ], [LOCAL_RESOURCE, suggestion('file_set', '参考文件集合', 'S2', 'local_only', '按需选择输入文件；不会自动扫描磁盘。')]),
  education: template('education', '教育学习', '组织课程材料、练习、反馈和学习成果', {
    title: '完成教学或学习单元',
    objective: '形成目标明确、材料完整、可评估的教学或学习闭环。',
    constraints: ['区分事实、推断和教学建议', '不虚构引用或成绩'],
    successCriteria: ['学习目标可测量', '材料与练习对应目标', '反馈可执行'],
    forbiddenActions: ['伪造来源、成绩或学术结论'],
    riskLevel: 'medium',
    acceptance: ['学习目标、材料和评估相互对应', '引用可追溯']
  }, [
    work('plan', 'planning', '定义学习目标与路径', '确定受众、先备知识、目标和评估方法。', [], ['requirement'], ['每个目标可观察或测量']),
    work('material', 'writing', '制作材料与练习', '生成课程材料、示例、练习和答案说明。', ['plan'], ['document', 'presentation'], ['材料覆盖全部学习目标']),
    work('assessment', 'review', '评估与反馈', '检查理解程度并输出下一步反馈。', ['material'], ['report'], ['反馈基于明确证据'])
  ], [LOCAL_RESOURCE, suggestion('knowledge_base', '课程知识库', 'S2', 'local_only', '可选关联经授权的课程资料。')]),
  research: template('research', '研究分析', '从问题、来源和证据到可审查结论', {
    title: '完成可审查研究',
    objective: '使用可追溯来源回答研究问题并明确不确定性。',
    constraints: ['来源与结论分离', '记录检索时间和版本', '无来源时不生成引用'],
    successCriteria: ['核心结论有独立证据', '冲突来源和局限已说明'],
    forbiddenActions: ['编造来源、数据或引用'],
    riskLevel: 'medium',
    acceptance: ['关键结论均有来源', '反例、局限和更新时间已记录']
  }, [
    work('question', 'planning', '冻结问题与证据标准', '定义研究问题、边界、时效和来源等级。', [], ['requirement'], ['问题和排除范围明确']),
    work('collect', 'research', '收集与交叉核对证据', '记录来源、版本、检索时间、主张和冲突。', ['question'], ['source'], ['每个关键主张至少有可追溯来源']),
    work('synthesis', 'analysis', '综合结论与局限', '形成结论、反证、信心度和待验证项。', ['collect'], ['report'], ['结论不超出证据范围'])
  ], [suggestion('knowledge_base', '研究资料库', 'S2', 'local_only', '可选关联本地或受控知识源。'), suggestion('url', '授权外部来源', 'S1', 'allow', '仅在用户明确添加后访问。')]),
  software: template('software', '软件开发', '覆盖理解、实现、独立审查、验证和交付', {
    title: '交付可验证的软件变更',
    objective: '在受控仓库中完成需求、实现、验证和可恢复交付。',
    constraints: ['保持改动范围清晰', '高风险操作需批准', '保留回滚路径'],
    successCriteria: ['实现满足需求', '构建或测试证据可追溯', '变更可审查和回滚'],
    forbiddenActions: ['未经确认发布、部署或删除远端数据'],
    riskLevel: 'high',
    acceptance: ['Diff 与需求一致', '验证结果和已知风险完整', '交付物可定位']
  }, [
    work('inspect', 'analysis', '理解代码与约束', '读取项目规则、架构、相关代码和验收条件。', [], ['requirement'], ['实现边界和依赖明确']),
    work('implement', 'coding', '实现变更', '在受控工作区完成最小完整实现。', ['inspect'], ['code', 'patch', 'diff'], ['代码覆盖需求且无越界改动']),
    work('verify', 'testing', '独立验证', '执行适当的构建、测试、诊断或人工检查。', ['implement'], ['test_report'], ['验证结论与实际输出一致']),
    work('deliver', 'delivery', '审查与交付', '汇总变更、证据、风险、回滚和交付位置。', ['verify'], ['release_package', 'report'], ['交付包、证据和遗留风险完整'])
  ], [suggestion('repository', '代码仓库', 'S2', 'local_only', '用户选择后才关联仓库；不会自动授予写入或网络权限。')]),
  opc: template('opc', '一人公司', '把调研、产品、内容、开发和运营串成一个可交付闭环', {
    title: '完成一轮产品经营目标',
    objective: '从市场证据出发形成方案、实现交付并记录运营结果。',
    constraints: ['预算和外部承诺必须显式', '不同阶段保留独立产物和验收'],
    successCriteria: ['决策有证据', '交付可使用', '运营结果可度量'],
    forbiddenActions: ['未经确认花费预算、发布内容或联系客户'],
    riskLevel: 'high',
    acceptance: ['研究、方案、交付和运营指标形成可追溯链']
  }, [
    work('research', 'research', '市场与用户证据', '收集目标用户、行业、需求和约束证据。', [], ['source', 'report'], ['关键判断有来源和信心度']),
    work('product', 'planning', '产品与交付方案', '确定范围、价值、预算、里程碑和验收。', ['research'], ['requirement', 'design'], ['范围与资源匹配']),
    work('build', 'coding', '制作核心交付物', '实现产品、内容或自动化的最小完整版本。', ['product'], ['code', 'document', 'presentation', 'custom'], ['交付物满足目标场景']),
    work('operate', 'operations', '运营与复盘', '经批准后执行运营动作并复盘指标。', ['build'], ['report'], ['外部动作有批准和结果回执'])
  ], [LOCAL_RESOURCE, suggestion('connector', '业务连接器', 'S1', 'deny', '默认禁止外发；负责人配置授权后再单独启用。')]),
  custom: template('custom', '自定义项目', '保留完整治理边界的空白项目骨架', {
    title: '定义并完成项目目标',
    objective: '明确目标、范围、产物和验收后再执行。',
    constraints: ['先确认范围和权限'],
    successCriteria: ['目标、产物和验收均已明确'],
    forbiddenActions: ['在范围或权限不清楚时产生外部副作用'],
    riskLevel: 'medium',
    acceptance: ['最终结果与已确认目标一致']
  }, [
    work('define', 'planning', '定义范围与验收', '补充背景、约束、预期产物和 Acceptance。', [], ['requirement'], ['范围和验收可执行']),
    work('deliver', 'delivery', '执行并交付', '按批准后的范围完成工作并汇总证据。', ['define'], ['custom', 'report'], ['交付物和证据完整'])
  ], [LOCAL_RESOURCE])
}

export function projectWorkspaceTemplate(kind: ProjectWorkspaceKind): ProjectWorkspaceTemplateDefinition {
  return structuredClone(TEMPLATES[kind])
}

export function listProjectWorkspaceTemplates(): ProjectWorkspaceTemplateDefinition[] {
  return Object.values(TEMPLATES).map((value) => structuredClone(value))
}

function template(
  id: ProjectWorkspaceKind,
  name: string,
  summary: string,
  goal: ProjectWorkspaceTemplateDefinition['goal'],
  workItems: ProjectWorkspaceTemplateDefinition['workItems'],
  resourceSuggestions: ProjectWorkspaceTemplateDefinition['resourceSuggestions']
): ProjectWorkspaceTemplateDefinition {
  return { schemaVersion: 1, id, name, summary, goal, workItems, resourceSuggestions }
}

function work(
  key: string,
  type: ProjectWorkspaceTemplateDefinition['workItems'][number]['type'],
  title: string,
  description: string,
  dependencyKeys: string[],
  expectedArtifactKinds: ProjectWorkspaceTemplateDefinition['workItems'][number]['expectedArtifactKinds'],
  acceptance: string[]
): ProjectWorkspaceTemplateDefinition['workItems'][number] {
  return { key, type, title, description, dependencyKeys, expectedArtifactKinds, acceptance }
}

function suggestion(
  kind: ProjectWorkspaceTemplateDefinition['resourceSuggestions'][number]['kind'],
  label: string,
  dataClass: ProjectWorkspaceTemplateDefinition['resourceSuggestions'][number]['dataClass'],
  egressPolicy: ProjectWorkspaceTemplateDefinition['resourceSuggestions'][number]['egressPolicy'],
  reason: string
): ProjectWorkspaceTemplateDefinition['resourceSuggestions'][number] {
  return { kind, label, dataClass, egressPolicy, reason }
}
