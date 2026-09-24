import { PROJECT_TEST_TRANSLATIONS } from './projectTestTranslations'
import { PROJECT_DEBUG_TRANSLATIONS } from './projectDebugTranslations'
import { PROJECT_REFACTOR_TRANSLATIONS } from './projectRefactorTranslations'

export const WORKBENCH_TRANSLATIONS = {
  ...PROJECT_TEST_TRANSLATIONS,
  ...PROJECT_DEBUG_TRANSLATIONS,
  ...PROJECT_REFACTOR_TRANSLATIONS,
  deskSources: { zh: '资料', en: 'Sources' },
  projectReviewTitle: { zh: '检查与提交', en: 'Review and commit' },
  projectReviewTestsStale: { zh: '代码已变化，请重新测试', en: 'Changes need to be tested again' },
  projectReviewTestEvidenceFailed: { zh: '测试证据未保存', en: 'Test evidence was not saved' },
  projectReviewNoTests: { zh: '未配置测试', en: 'No tests configured' },
  projectReviewTestsPassed: { zh: '测试已通过', en: 'Tests passed' },
  projectReviewTestsFailed: { zh: '测试未通过', en: 'Tests did not pass' },
  projectReviewNeedsTest: { zh: '等待测试', en: 'Tests required' },
  projectReviewPendingChanges: { zh: '项未暂存改动', en: 'unstaged changes' },
  projectReviewRunDefault: { zh: '运行默认测试', en: 'Run default test' },
  projectReviewUndo: { zh: '撤销改动', en: 'Undo changes' }
} as const
