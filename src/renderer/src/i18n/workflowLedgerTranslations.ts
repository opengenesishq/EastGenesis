export const WORKFLOW_LEDGER_TRANSLATIONS = {
  workflowLedgerTitle: { zh: '工作流账本', en: 'Workflow Ledger' },
  workflowLedgerSubtitle: { zh: '目标 · 工作项 · 运行 · 事件', en: 'Goal · WorkItem · Run · Event' },
  workflowLedgerCreateAcceptanceTitle: {
    zh: '创建带 Evidence policy 的 pending Acceptance',
    en: 'Create a pending Acceptance with an Evidence policy'
  },
  workflowLedgerCloseAuthoring: { zh: '关闭创建', en: 'Close form' },
  workflowLedgerNewAcceptance: { zh: '新建验收', en: 'New acceptance' },
  workflowLedgerRefreshTitle: { zh: '刷新工作流账本', en: 'Refresh Workflow Ledger' },
  workflowLedgerRefreshing: { zh: '刷新中...', en: 'Refreshing...' },
  workflowLedgerGoals: { zh: '目标', en: 'Goals' },
  workflowLedgerWorkItems: { zh: '工作项', en: 'WorkItems' },
  workflowLedgerRuns: { zh: '运行', en: 'Runs' },
  workflowLedgerArtifacts: { zh: '产物', en: 'Artifacts' },
  workflowLedgerAcceptance: { zh: '验收', en: 'Acceptance' },
  workflowLedgerEvents: { zh: '事件', en: 'Events' },
  workflowLedgerChainValid: { zh: '链校验通过', en: 'Ledger chain verified' },
  workflowLedgerAwaitingVerification: { zh: '等待校验', en: 'Awaiting verification' },
  workflowLedgerNoWorkItems: { zh: '暂无 WorkItem 投影', en: 'No WorkItem projections' },
  workflowLedgerRevisionRuns: {
    zh: '修订 {revision} · {count} 次运行',
    en: 'r{revision} · {count} runs'
  },
  workflowLedgerAcceptanceList: { zh: 'Acceptance 列表', en: 'Acceptance list' },
  workflowLedgerAcceptancePolicies: { zh: '验收策略', en: 'Acceptance policies' },
  workflowLedgerSavedRecordsReadonly: {
    zh: '已保存记录只读展示',
    en: 'Saved records are read-only'
  },
  workflowLedgerMissingProject: {
    zh: '所选 WorkItem 缺少 Project 归属，已拒绝保存',
    en: 'The selected WorkItem has no Project assignment and cannot be saved'
  },
  workflowLedgerCriterionRequired: {
    zh: '每个 criterion 都必须填写内容',
    en: 'Every criterion must include a description'
  },
  workflowLedgerEvidenceSourceRequired: {
    zh: '每个 criterion 至少需要一个允许的 Evidence source',
    en: 'Every criterion must allow at least one Evidence source'
  },
  workflowLedgerAcceptanceCreated: {
    zh: '已创建 pending Acceptance {id}',
    en: 'Created pending Acceptance {id}'
  },
  workflowLedgerAuthoringTitle: { zh: '验收策略创建', en: 'Acceptance policy authoring' },
  workflowLedgerAuthoringHint: {
    zh: '策略在创建时冻结；保存后只能通过新的 revision/retest 流程改变状态。',
    en: 'Policies are frozen when created. After saving, status changes require a new revision or retest.'
  },
  workflowLedgerClear: { zh: '清空', en: 'Clear' },
  workflowLedgerWorkItem: { zh: '工作项', en: 'WorkItem' },
  workflowLedgerAddCriterion: { zh: '添加 criterion', en: 'Add criterion' },
  workflowLedgerSaving: { zh: '保存中...', en: 'Saving...' },
  workflowLedgerSavePendingAcceptance: { zh: '保存 pending Acceptance', en: 'Save pending Acceptance' },
  workflowLedgerCriterionNumber: { zh: 'Criterion {number}', en: 'Criterion {number}' },
  workflowLedgerRemove: { zh: '移除', en: 'Remove' },
  workflowLedgerContent: { zh: '内容', en: 'Description' },
  workflowLedgerEvidenceKind: { zh: 'Evidence 类型', en: 'Evidence kind' },
  workflowLedgerAllowedSources: { zh: '允许来源', en: 'Allowed sources' },
  workflowLedgerCriteriaRevision: {
    zh: '{count} 条 criterion · 修订 {revision}',
    en: '{count} criteria · revision {revision}'
  },
  workflowLedgerRepairStarting: { zh: '启动中...', en: 'Starting...' },
  workflowLedgerStartRepair: { zh: '开始返工', en: 'Start rework' },
  workflowLedgerRepairStarted: { zh: '返工任务已启动', en: 'Rework task started' },
  workflowLedgerLegacyPolicy: { zh: '旧版策略', en: 'Legacy policy' },
  workflowLedgerReviewEvidence: { zh: '复核 / Evidence', en: 'Review / Evidence' },
  workflowLedgerCancelEvidence: { zh: '取消 Evidence', en: 'Cancel Evidence' },
  workflowLedgerAddEvidence: { zh: '添加 Evidence', en: 'Add Evidence' },
  workflowLedgerWaiverReason: { zh: '豁免理由', en: 'Waiver reason' },
  workflowLedgerWaiverPlaceholder: { zh: '仅在豁免时填写', en: 'Required only when waiving' },
  workflowLedgerEvidenceTitle: { zh: '标题', en: 'Title' },
  workflowLedgerEvidenceSummary: { zh: '摘要', en: 'Summary' },
  workflowLedgerSaveEvidence: { zh: '保存 Evidence', en: 'Save Evidence' },
  workflowLedgerAnyKind: { zh: '任意类型', en: 'any kind' },
  workflowLedgerAnySource: { zh: '任意来源', en: 'any source' },
  workflowLedgerNoMatchingEvidence: {
    zh: '暂无匹配 Evidence（要求 {kind} / {source}）',
    en: 'No matching Evidence (requires {kind} / {source})'
  },
  workflowLedgerPass: { zh: '通过', en: 'Pass' },
  workflowLedgerMarkFailed: { zh: '标记失败', en: 'Mark failed' },
  workflowLedgerWaive: { zh: '豁免', en: 'Waive' },
  workflowLedgerStartRetest: { zh: '开始重测', en: 'Start retest' },
  workflowLedgerEvidenceTitleProjectRequired: {
    zh: 'Evidence title 和 Project 归属不能为空',
    en: 'Evidence title and Project assignment are required'
  },
  workflowLedgerEvidenceRecorded: {
    zh: 'Evidence 已记录；请选择它覆盖对应 criterion',
    en: 'Evidence recorded. Select it for the corresponding criterion.'
  },
  workflowLedgerWaiverReasonRequired: { zh: '豁免必须填写理由', en: 'A reason is required to waive acceptance' },
  workflowLedgerCriterionEvidenceRequired: {
    zh: '通过或失败前必须为每个 criterion 选择 Evidence',
    en: 'Select Evidence for every criterion before passing or failing acceptance'
  },
  workflowLedgerAcceptanceReviewed: { zh: 'Acceptance 已{decision}', en: 'Acceptance {decision}' },
  workflowLedgerDecisionPassed: { zh: '通过', en: 'passed' },
  workflowLedgerDecisionFailed: { zh: '标记失败', en: 'marked failed' },
  workflowLedgerDecisionRetest: { zh: '进入重测', en: 'moved to retest' },
  workflowLedgerDecisionWaived: { zh: '豁免', en: 'waived' }
} as const
