import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureProjectSkillReadinessSync } from '../learning/learning-lifecycle'
import { caogenUserExtensionRoot, isAllowedCaogenExtensionRoot } from '../plugin/caogen-extension-roots'

export type SkillScope = 'builtin' | 'global' | 'project'

export interface SkillParameterSchema {
  type: 'object'
  properties: Record<string, SkillParameterProperty>
  required?: string[]
}

export interface SkillParameterProperty {
  type: 'string' | 'number' | 'boolean'
  description?: string
  default?: string | number | boolean
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  trigger?: string
  tags: string[]
  version?: string
  scope: SkillScope
  sourcePath?: string
  sourceContentDigest?: string
  body: string
  steps: string[]
  verification: string[]
  parameterSchema?: SkillParameterSchema
  updatedAt: number
}

export interface SkillLoadDiagnostic {
  code: 'root_missing' | 'read_failed' | 'invalid_skill' | 'materialization_failed' | 'authorization_blocked'
  path: string
  message: string
}

export interface SkillLoadResult {
  roots: string[]
  skills: SkillDefinition[]
  diagnostics: SkillLoadDiagnostic[]
}

interface Frontmatter {
  name?: string
  description?: string
  trigger?: string
  tags?: string[]
  version?: string
}

const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 512 * 1024
const BUILTIN_UPDATED_AT = Date.parse('2026-07-06T00:00:00.000Z')

export function defaultSkillRoots(projectRoot?: string): Array<{ root: string; scope: Exclude<SkillScope, 'builtin'> }> {
  const roots: Array<{ root: string; scope: Exclude<SkillScope, 'builtin'> }> = [
    { root: join(caogenUserExtensionRoot(), 'skills'), scope: 'global' }
  ]
  if (projectRoot?.trim()) roots.unshift({ root: join(projectRoot, '.caogen', 'skills'), scope: 'project' })
  return roots.filter(item => isAllowedCaogenExtensionRoot(item.root))
}

export function loadSkills(projectRoot?: string): SkillLoadResult {
  const diagnostics: SkillLoadDiagnostic[] = []
  const loaded: SkillDefinition[] = [...builtinSkills()]
  const roots = defaultSkillRoots(projectRoot)
  let projectMaterializationError: string | undefined

  if (projectRoot?.trim() && roots.some(item => item.scope === 'project')) {
    try {
      ensureProjectSkillReadinessSync(projectRoot)
    } catch (error) {
      projectMaterializationError = error instanceof Error ? error.message : String(error)
    }
  }

  for (const item of roots) {
    if (item.scope === 'project' && projectMaterializationError) {
      diagnostics.push({
        code: 'materialization_failed',
        path: item.root,
        message: `Project Skills blocked until Learning recovery succeeds: ${projectMaterializationError}`
      })
      continue
    }
    if (!existsSync(item.root)) {
      diagnostics.push({ code: 'root_missing', path: item.root, message: 'Skill 根目录不存在。' })
      continue
    }
    if (item.scope === 'project') {
      const rootStat = lstatSync(item.root)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        diagnostics.push({ code: 'invalid_skill', path: item.root, message: '项目 Skill 根目录必须是真实目录,不能是符号链接。' })
        continue
      }
    }
    for (const skillPath of findSkillFiles(item.root)) {
      const parsed = readSkillFile(skillPath, item.scope)
      if ('diagnostic' in parsed) diagnostics.push(parsed.diagnostic)
      else loaded.push(parsed.skill)
    }
  }

  return {
    roots: roots.map((item) => item.root),
    skills: dedupeSkills(loaded),
    diagnostics
  }
}

export function parseSkillMarkdown(
  sourcePath: string,
  raw: string,
  scope: SkillScope,
  updatedAt = Date.now()
): SkillDefinition {
  const { frontmatter, body } = splitFrontmatter(raw)
  const name = cleanText(frontmatter.name) || cleanText(firstHeading(body)) || basename(dirname(sourcePath))
    const description = cleanText(frontmatter.description) || cleanText(firstParagraph(body)) || 'EastGenesis Skill'
  const tags = frontmatter.tags ?? []
  return {
    id: skillId(scope, sourcePath, name),
    name,
    description,
    trigger: cleanText(frontmatter.trigger),
    tags,
    version: cleanText(frontmatter.version),
    scope,
    sourcePath,
    sourceContentDigest: createHash('sha256').update(raw).digest('hex'),
    body,
    steps: sectionList(body, ['执行步骤', '步骤', 'Steps']),
    verification: sectionList(body, ['验证', '验收', 'Verification']),
    updatedAt
  }
}

export function serializeSkill(skill: Pick<SkillDefinition, 'name' | 'description' | 'trigger' | 'tags' | 'version' | 'body'>): string {
  const meta = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    ...(skill.trigger ? [`trigger: ${skill.trigger}`] : []),
    ...(skill.tags.length > 0 ? [`tags: [${skill.tags.join(', ')}]`] : []),
    ...(skill.version ? [`version: ${skill.version}`] : []),
    '---',
    ''
  ]
  return `${meta.join('\n')}${skill.body.trim()}\n`
}

function readSkillFile(path: string, scope: Exclude<SkillScope, 'builtin'>): { skill: SkillDefinition } | { diagnostic: SkillLoadDiagnostic } {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) {
      return { diagnostic: { code: 'invalid_skill', path, message: 'Skill 路径不是文件。' } }
    }
    if (stat.size > MAX_SKILL_BYTES) {
      return { diagnostic: { code: 'read_failed', path, message: `Skill 文件超过 ${MAX_SKILL_BYTES} 字节。` } }
    }
    const raw = readFileSync(path, 'utf8')
    return { skill: parseSkillMarkdown(path, raw, scope, stat.mtimeMs) }
  } catch (error) {
    return { diagnostic: { code: 'read_failed', path, message: error instanceof Error ? error.message : String(error) } }
  }
}

function findSkillFiles(root: string): string[] {
  const out: string[] = []
  const stack = [resolve(root)]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name === SKILL_FILE) {
        out.push(fullPath)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md' && basename(dir) === 'skills') {
        out.push(fullPath)
      }
    }
  }
  return out.sort()
}

function splitFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, body: raw.trim() }
  const meta: Record<string, string> = {}
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---') {
      end = i
      break
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match) meta[match[1]] = stripQuotes(match[2])
  }
  const tags = parseTags(meta.tags)
  return {
    frontmatter: {
      name: meta.name,
      description: meta.description ?? meta.summary,
      trigger: meta.trigger,
      tags,
      version: meta.version
    },
    body: lines.slice(end >= 0 ? end + 1 : 0).join('\n').trim()
  }
}

function parseTags(value: string | undefined): string[] {
  if (!value) return []
  const trimmed = value.trim()
  const list = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1).split(',')
    : trimmed.split(/[,\s]+/)
  return list.map((item) => stripQuotes(item).trim()).filter(Boolean).slice(0, 20)
}

function sectionList(body: string, headings: string[]): string[] {
  const lines = body.split(/\r?\n/)
  const headingSet = new Set(headings.map((item) => item.toLowerCase()))
  let active = false
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    const heading = /^#{1,4}\s+(.+)$/.exec(line)
    if (heading) {
      active = headingSet.has(heading[1].trim().toLowerCase())
      continue
    }
    if (!active) continue
    const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
    if (item?.[1]) out.push(item[1].trim())
  }
  return out.slice(0, 50)
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]
}

function firstParagraph(body: string): string | undefined {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line && !line.startsWith('#') && !line.startsWith('-') && !/^\d+\./.test(line)) return line
  }
  return undefined
}

function cleanText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text || undefined
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function skillId(scope: SkillScope, sourcePath: string, name: string): string {
  const hash = createHash('sha256').update(`${scope}\0${resolve(sourcePath)}\0${name}`).digest('hex').slice(0, 12)
  return `${scope}:${slug(name)}:${hash}`
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill'
}

function dedupeSkills(skills: SkillDefinition[]): SkillDefinition[] {
  const seen = new Set<string>()
  const out: SkillDefinition[] = []
  for (const skill of skills) {
    const key = `${skill.scope}\0${skill.name}\0${skill.sourcePath ?? skill.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(skill)
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
}

function builtinSkills(): SkillDefinition[] {
  const names = [
    ['初始化 React+TS 项目', '创建 Vite React TypeScript 项目并配置基础脚手架', ['前端', '初始化']],
    ['修复 ESLint', '读取 lint 输出并逐项修复 TypeScript/ESLint 问题', ['质量', 'lint']],
    ['生成 Dockerfile', '根据项目语言生成可构建的 Dockerfile', ['部署', '容器']],
    ['编写单元测试', '为核心函数补充聚焦单元测试', ['测试']],
    ['部署 Vercel', '检查 Vercel 配置并生成部署步骤', ['部署']],
    ['生成 CHANGELOG', '根据 Git 历史生成结构化变更日志', ['文档']],
    ['Figma 转代码', '结合浏览器上下文提取设计信息并生成前端代码', ['前端', 'Figma']],
    ['性能审计', '定位慢路径并给出可验证优化', ['性能']],
    ['安全扫描', '检查常见注入、密钥泄漏和权限边界', ['安全']],
    ['数据库迁移', '生成可回滚数据库迁移与验证脚本', ['数据库']],
    ['API 合约测试', '为 HTTP API 生成契约测试', ['测试', 'API']],
    ['错误复现', '把用户报错变成最小复现和修复计划', ['调试']],
    ['Release 检查', '运行构建、测试、打包前检查并输出证据', ['发布']],
    ['依赖升级', '评估依赖升级风险并执行最小变更', ['依赖']],
    ['CLI 工具封装', '把脚本整理成可复用 CLI 命令', ['工程化']],
    ['Tailwind UI 调整', '按现有设计系统优化 Tailwind 组件', ['前端', 'UI']],
    ['Electron 打包检查', '检查 Electron 构建、图标和 asar 配置', ['桌面']],
    ['PostgreSQL 验证', '对数据库路径执行真实 PostgreSQL 验证', ['数据库', '验证']],
    ['测试失败归因', '聚合失败日志并定位首个真实失败点', ['测试', '调试']],
    ['项目 README 更新', '根据当前功能更新 README 和使用说明', ['文档']],
    ['MCP 服务接入', '导入并验证 stdio/SSE MCP 服务与工具映射', ['MCP', '集成']]
  ] satisfies Array<[string, string, string[]]>

  return names.map(([name, description, tags]) => ({
    id: `builtin:${slug(name)}`,
    name,
    description,
    trigger: name,
    tags,
    scope: 'builtin',
    body: builtinSkillBody(name, description),
    steps: builtinSkillSteps(name),
    verification: builtinSkillVerification(name),
    updatedAt: BUILTIN_UPDATED_AT
  }))
}

function builtinSkillBody(name: string, description: string): string {
  if (name === 'Figma 转代码') {
    return [
      `# ${name}`,
      '',
      description,
      '',
      '# 执行步骤',
      '1. 确认 Figma URL、节点范围、访问 token 或已打开的浏览器页面。',
      '2. 使用浏览器工具截图并记录目标节点、布局、颜色、字号、间距和组件状态。',
      '3. 对照现有前端组件库与 Tailwind 配置，生成最小可维护组件。',
      '4. 保留设计 token 映射和响应式约束，避免一次性硬编码布局。',
      '',
      '# 验证',
      '1. 运行 typecheck/build 或项目指定前端验证命令。',
      '2. 截图比对关键断点，记录与 Figma 的差异。'
    ].join('\n')
  }
  return `# ${name}\n\n${description}\n\n# 执行步骤\n1. 读取项目上下文。\n2. 执行最小可验证变更。\n\n# 验证\n1. 运行相关测试并记录结果。`
}

function builtinSkillSteps(name: string): string[] {
  if (name === 'Figma 转代码') {
    return [
      '确认 Figma URL、节点范围、访问 token 或浏览器页面。',
      '使用浏览器工具采集截图、布局、颜色、字号、间距和组件状态。',
      '复用现有组件库与 Tailwind 配置生成最小可维护组件。',
      '记录设计 token 映射和响应式约束。'
    ]
  }
  return ['读取项目上下文。', '执行最小可验证变更。']
}

function builtinSkillVerification(name: string): string[] {
  if (name === 'Figma 转代码') {
    return ['运行 typecheck/build 或项目指定前端验证命令。', '截图比对关键断点并记录差异。']
  }
  return ['运行相关测试并记录结果。']
}
