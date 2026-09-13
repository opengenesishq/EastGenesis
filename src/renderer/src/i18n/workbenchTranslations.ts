import { PROJECT_TEST_TRANSLATIONS } from './projectTestTranslations'
import { PROJECT_DEBUG_TRANSLATIONS } from './projectDebugTranslations'
import { PROJECT_REFACTOR_TRANSLATIONS } from './projectRefactorTranslations'

export const WORKBENCH_TRANSLATIONS = {
  ...PROJECT_TEST_TRANSLATIONS,
  ...PROJECT_DEBUG_TRANSLATIONS,
  ...PROJECT_REFACTOR_TRANSLATIONS
} as const
