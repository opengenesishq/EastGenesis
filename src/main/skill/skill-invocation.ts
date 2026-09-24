import { SkillManager, type SkillMatch } from './skill-manager'

export interface SkillInvocationPromptOptions {
  enabled: boolean
  projectRoot: string
  query: string
  threshold?: number
  maxSkills?: number
}

const DEFAULT_THRESHOLD = 0.42
const PROJECT_SKILL_THRESHOLD = 0.34
const DEFAULT_MAX_SKILLS = 2
const MAX_FIELD_CHARS = 900

export function buildSkillInvocationPrompt(options: SkillInvocationPromptOptions): string {
  if (!options.enabled) return ''
  const query = options.query.trim()
  if (!query) return ''

  const manager = new SkillManager({ projectRoot: options.projectRoot })
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const matches = manager
    .match(query, Math.min(threshold, PROJECT_SKILL_THRESHOLD))
    .filter((match) => {
      if (match.skill.scope === 'project') return match.score >= PROJECT_SKILL_THRESHOLD
      if (match.skill.scope === 'builtin') return match.score >= 0.75
      return match.score >= threshold
    })
    .slice(0, normalizeMaxSkills(options.maxSkills))
  if (matches.length === 0) return ''
  for (const match of matches) manager.authorize(match.skill)

  return [
    '## 自动匹配的 EastGenesis Skill',
    '以下 Skill 与当前任务相似。请优先复用其中的步骤和验证方式；如果不适用，请简要说明原因后继续正常执行。',
    '',
    ...matches.flatMap(formatSkillMatch)
  ].join('\n')
}

function normalizeMaxSkills(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return DEFAULT_MAX_SKILLS
  return Math.min(5, value)
}

function formatSkillMatch(match: SkillMatch, index: number): string[] {
  const skill = match.skill
  const lines = [
    `### ${index + 1}. ${skill.name}`,
    `- scope: ${skill.scope}`,
    `- score: ${match.score.toFixed(3)}`,
    `- description: ${compact(skill.description)}`,
    skill.trigger ? `- trigger: ${compact(skill.trigger, 240)}` : '',
    skill.tags.length > 0 ? `- tags: ${skill.tags.join(', ')}` : '',
    match.reasons.length > 0 ? `- reasons: ${match.reasons.join('; ')}` : '',
    skill.steps.length > 0 ? ['- steps:', ...skill.steps.slice(0, 6).map((step) => `  ${step}`)].join('\n') : '',
    skill.verification.length > 0
      ? ['- verification:', ...skill.verification.slice(0, 4).map((item) => `  ${item}`)].join('\n')
      : '',
    skill.sourcePath ? `- source: ${skill.sourcePath}` : ''
  ]
  return lines.filter((line) => line.trim().length > 0)
}

function compact(value: string, max = MAX_FIELD_CHARS): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trim()}…`
}
