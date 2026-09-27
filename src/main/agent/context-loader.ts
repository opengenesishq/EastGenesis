import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const CONTEXT_FILES = ['caogen.md', '.caogen.md', 'README.md'] as const
const ROOT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'tsconfig.json'
] as const
const MAX_CONTEXT_BYTES = 48 * 1024
const MAX_PROMPT_CHARS = 32_000

export type ProjectContextFileName = (typeof CONTEXT_FILES)[number]

export interface ProjectContextSource {
  fileName: ProjectContextFileName
  path: string
  bytes: number
  truncated: boolean
}

export interface ProjectDetectedStack {
  packageName?: string
  packageManager?: string
  nodeScripts: Array<{ name: string; command: string }>
  dependencies: Array<{ name: string; version: string; scope: 'runtime' | 'dev' }>
  techStack: string[]
  python?: { projectName?: string; dependencies: string[] }
  go?: { module?: string; version?: string; requirements: string[] }
  rust?: { packageName?: string; dependencies: string[] }
}

export interface ProjectContextReadResult {
  projectRoot: string
  source?: ProjectContextSource
  content: string
  detected: ProjectDetectedStack
  template: string
  prompt: string
}

export type ProjectModelDispatchStrategy = 'cost' | 'speed' | 'balanced' | 'quality'

export interface ProjectModelDispatchTarget {
  providerId?: string
  model?: string
  source: string
}

export interface ProjectModelDispatchHints {
  strategy?: ProjectModelDispatchStrategy
  strategySource?: string
  lowCost?: ProjectModelDispatchTarget
  strongReasoning?: ProjectModelDispatchTarget
  review?: ProjectModelDispatchTarget
}

interface ReadTextResult {
  text: string
  bytes: number
  truncated: boolean
}

/** 定位项目根目录:优先包含 caogen 上下文文件的上级目录,其次常见工程根标记。 */
export function resolveProjectRoot(startPath: string): string {
  const start = normalizeExistingDirectory(startPath)
  const userHome = resolve(homedir())
  let current = start
  let firstMarkerDir: string | null = null
  while (true) {
    if (samePath(current, userHome) && !samePath(start, userHome)) break
    if (CONTEXT_FILES.some((name) => existsSync(join(current, name)))) return current
    if (!firstMarkerDir && ROOT_MARKERS.some((name) => existsSync(join(current, name)))) {
      firstMarkerDir = current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return firstMarkerDir ?? start
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

export function readProjectContext(projectPath: string): ProjectContextReadResult {
  const projectRoot = resolveProjectRoot(projectPath)
  const source = findContextSource(projectRoot)
  const content = source ? readTextLimited(source.path, MAX_CONTEXT_BYTES).text : ''
  const detected = detectProjectStack(projectRoot)
  const template = generateProjectContextTemplate(projectRoot, detected)
  const prompt = renderProjectContextPrompt({ projectRoot, source, content, detected })
  return { projectRoot, source, content, detected, template, prompt }
}

export async function loadProjectContext(projectPath: string): Promise<ProjectContextReadResult> {
  return readProjectContext(projectPath)
}

export function buildProjectContextSystemAppendSync(projectPath: string): string {
  try {
    return readProjectContext(projectPath).prompt
  } catch (err) {
    console.error('[caogen] 读取项目上下文失败:', err)
    return ''
  }
}

export async function buildProjectContextSystemAppend(projectPath: string): Promise<string> {
  return buildProjectContextSystemAppendSync(projectPath)
}

export function buildProjectScopedPromptSync(projectPath: string, prompt: string): string {
  const userPrompt = prompt.trim()
  const projectContext = buildProjectContextSystemAppendSync(projectPath).trim()
  if (!projectContext) return userPrompt
  return [
    '# EastGenesis 项目规则',
    '以下内容来自当前项目的 EastGenesis 项目规则文件或 README。除非用户本轮明确覆盖,必须优先遵守这些项目规则。',
    projectContext,
    '# 当前用户请求',
    userPrompt
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function readProjectModelDispatchHintsSync(projectPath: string): ProjectModelDispatchHints {
  try {
    return parseProjectModelDispatchHints(readProjectContext(projectPath).content)
  } catch (err) {
    console.error('[caogen] 读取项目模型调度策略失败:', err)
    return {}
  }
}

export function parseProjectModelDispatchHints(content: string): ProjectModelDispatchHints {
  const section = extractProjectSection(content, ['模型调度策略', 'model dispatch', 'model routing'])
  if (!section.trim()) return {}
  const hints: ProjectModelDispatchHints = {}
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.replace(/^[-*]\s*/, '').trim()
    if (!line) continue
    const strategy = parseProjectDispatchStrategy(line)
    if (strategy && !hints.strategy) {
      hints.strategy = strategy
      hints.strategySource = line
    }
    const target = parseDispatchTarget(line)
    if (!target) continue
    const lower = line.toLowerCase()
    if (!hints.review && hasAny(lower, ['审查', '复核', 'review'])) {
      hints.review = { ...target, source: line }
    } else if (!hints.strongReasoning && hasAny(lower, ['复杂', '强推理', '架构', '规划', 'complex', 'reasoning', 'architecture'])) {
      hints.strongReasoning = { ...target, source: line }
    } else if (!hints.lowCost && hasAny(lower, ['简单', '快速', '轻量', '低成本', 'simple', 'quick', 'fast', 'low-cost', 'low cost'])) {
      hints.lowCost = { ...target, source: line }
    }
  }
  return hints
}

export function writeProjectContext(projectPath: string, content: string): ProjectContextReadResult {
  if (typeof content !== 'string') throw new Error('EastGenesis 项目规则内容必须是字符串')
  const projectRoot = resolveProjectRoot(projectPath)
  const target = join(projectRoot, 'caogen.md')
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(target, content, 'utf8')
  return readProjectContext(projectRoot)
}

export function generateProjectContextTemplate(
  projectPath: string,
  detected = detectProjectStack(resolveProjectRoot(projectPath))
): string {
  const commands = detected.nodeScripts.slice(0, 8)
  const commandLines =
    commands.length > 0
      ? commands.map((item) => `- ${item.name}: ${item.command}`).join('\n')
      : '- install: \n- dev: \n- build: \n- test: '
  const stack = detected.techStack.length > 0 ? detected.techStack.join(' + ') : '请填写主要技术栈'
  return [
    '# 项目提示词',
    '- 本项目中 Agent 的默认工作方式: ',
    '- 回答语言 / 风格: ',
    '- 需要长期遵守的业务边界: ',
    '',
    '# 项目背景',
    '- 项目目标: ',
    '- 主要用户 / 使用场景: ',
    '- 当前阶段: ',
    '',
    '# 技术栈与架构',
    `- 技术栈: ${stack}`,
    '- 关键模块: ',
    '- 数据 / 状态来源: ',
    '',
    '# 代码规范',
    '- 命名: ',
    '- 格式: ',
    '- 禁止事项: ',
    '',
    '# 常用命令',
    commandLines,
    '',
    '# 测试命令',
    '- 默认测试命令: ',
    '- 专项 smoke: ',
    '- 回归门禁: ',
    '',
    '# 构建命令',
    '- 默认构建命令: ',
    '- 发布前检查: ',
    '',
    '# 禁止修改目录',
    '- ',
    '',
    '# 工作区隔离策略',
    '- 默认是否使用隔离 worktree: ',
    '- 可直接修改的范围: ',
    '- 需要用户确认的范围: ',
    '',
    '# 模型调度策略',
    '- 简单任务: ',
    '- 复杂任务: ',
    '- 审查 / 复核任务: ',
    '- 成本 / 速度 / 质量偏好: ',
    '',
    '# 项目记忆',
    '- 已确认事实: ',
    '- 重要文件 / 入口: ',
    '- 不要重复尝试: ',
    '',
    '# 历史决策',
    '- ',
    '',
    '# 交付验收',
    '- 验证命令: ',
    '- 完成标准: ',
    '- 风险说明: ',
    ''
  ].join('\n')
}

function normalizeExistingDirectory(startPath: string): string {
  if (typeof startPath !== 'string' || !startPath.trim()) throw new Error('必须指定项目目录')
  const resolved = resolve(startPath)
  const info = statSync(resolved)
  return info.isDirectory() ? resolved : dirname(resolved)
}

function findContextSource(projectRoot: string): ProjectContextSource | undefined {
  for (const fileName of CONTEXT_FILES) {
    const path = join(projectRoot, fileName)
    if (!existsSync(path)) continue
    const read = readTextLimited(path, MAX_CONTEXT_BYTES)
    return { fileName, path, bytes: read.bytes, truncated: read.truncated }
  }
  return undefined
}

function readTextLimited(filePath: string, maxBytes: number): ReadTextResult {
  const buffer = readFileSync(filePath)
  const sliced = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer
  return {
    text: sliced.toString('utf8'),
    bytes: buffer.byteLength,
    truncated: buffer.byteLength > maxBytes
  }
}

function detectProjectStack(projectRoot: string): ProjectDetectedStack {
  const detected: ProjectDetectedStack = {
    nodeScripts: [],
    dependencies: [],
    techStack: []
  }
  readPackageJson(projectRoot, detected)
  readPyproject(projectRoot, detected)
  readGoMod(projectRoot, detected)
  readCargoToml(projectRoot, detected)
  detected.techStack = [...new Set(detected.techStack)].slice(0, 16)
  return detected
}

function readPackageJson(projectRoot: string, detected: ProjectDetectedStack): void {
  const packagePath = join(projectRoot, 'package.json')
  if (!existsSync(packagePath)) return
  const parsed = readJson(packagePath)
  if (!isRecord(parsed)) return
  if (typeof parsed.name === 'string') detected.packageName = parsed.name
  detected.packageManager = detectPackageManager(projectRoot)
  const scripts = isRecord(parsed.scripts) ? parsed.scripts : {}
  detected.nodeScripts = Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .slice(0, 24)
    .map(([name, command]) => ({ name, command }))
  addDependencies(parsed.dependencies, 'runtime', detected)
  addDependencies(parsed.devDependencies, 'dev', detected)
  inferNodeTech(detected)
}

function readPyproject(projectRoot: string, detected: ProjectDetectedStack): void {
  const filePath = join(projectRoot, 'pyproject.toml')
  if (!existsSync(filePath)) return
  const text = readTextLimited(filePath, 24 * 1024).text
  detected.techStack.push('Python')
  const projectName = matchTomlString(text, 'name')
  const dependencies = matchTomlArray(text, 'dependencies').slice(0, 20)
  detected.python = { projectName, dependencies }
}

function readGoMod(projectRoot: string, detected: ProjectDetectedStack): void {
  const filePath = join(projectRoot, 'go.mod')
  if (!existsSync(filePath)) return
  const text = readTextLimited(filePath, 24 * 1024).text
  detected.techStack.push('Go')
  const module = /^module\s+(.+)$/m.exec(text)?.[1]?.trim()
  const version = /^go\s+(.+)$/m.exec(text)?.[1]?.trim()
  const requirements = [...text.matchAll(/^\s*require\s+([^\s()]+)\s+([^\s()]+)/gm)]
    .slice(0, 20)
    .map((match) => `${match[1]} ${match[2]}`)
  detected.go = { module, version, requirements }
}

function readCargoToml(projectRoot: string, detected: ProjectDetectedStack): void {
  const filePath = join(projectRoot, 'Cargo.toml')
  if (!existsSync(filePath)) return
  const text = readTextLimited(filePath, 24 * 1024).text
  detected.techStack.push('Rust')
  const packageName = matchTomlString(text, 'name')
  const dependencies = extractTomlSectionKeys(text, 'dependencies').slice(0, 20)
  detected.rust = { packageName, dependencies }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

function detectPackageManager(projectRoot: string): string | undefined {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectRoot, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(projectRoot, 'package-lock.json'))) return 'npm'
  if (existsSync(join(projectRoot, 'bun.lockb')) || existsSync(join(projectRoot, 'bun.lock'))) return 'bun'
  return undefined
}

function addDependencies(value: unknown, scope: 'runtime' | 'dev', detected: ProjectDetectedStack): void {
  if (!isRecord(value)) return
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string') continue
    detected.dependencies.push({ name, version, scope })
  }
}

function inferNodeTech(detected: ProjectDetectedStack): void {
  const names = new Set(detected.dependencies.map((item) => item.name))
  if (detected.packageName || detected.dependencies.length > 0 || detected.nodeScripts.length > 0) {
    detected.techStack.push('Node.js')
  }
  if (names.has('typescript')) detected.techStack.push('TypeScript')
  if (names.has('react')) detected.techStack.push('React')
  if (names.has('electron')) detected.techStack.push('Electron')
  if (names.has('vite') || names.has('electron-vite')) detected.techStack.push('Vite')
  if (names.has('vue')) detected.techStack.push('Vue')
  if (names.has('next')) detected.techStack.push('Next.js')
  if (names.has('tailwindcss')) detected.techStack.push('Tailwind CSS')
}

function renderProjectContextPrompt(input: {
  projectRoot: string
  source?: ProjectContextSource
  content: string
  detected: ProjectDetectedStack
}): string {
  const parts: string[] = [
    [
      '# 项目身份',
      `项目根目录: ${input.projectRoot}`,
      input.source
        ? '项目规则文件: EastGenesis 项目规则'
        : '项目规则文件: 未找到；本轮仅使用自动识别的项目栈与用户请求。'
    ].join('\n')
  ]
  if (input.content.trim()) {
    parts.push(
      [
        '# 项目永久上下文',
        `来源: ${input.source ? 'EastGenesis 项目规则文件' : '未找到上下文文件'}`,
        input.source?.truncated ? `提示: 文件超过 ${MAX_CONTEXT_BYTES} 字节,已截断注入。` : '',
        input.content.trim()
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  const detected = renderDetectedStack(input.detected)
  if (detected) parts.push(detected)
  const prompt = parts.join('\n\n').trim()
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n\n[项目上下文已截断]` : prompt
}

function extractProjectSection(content: string, names: string[]): string {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  let active = false
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const title = heading[1].trim().toLowerCase()
      active = names.some((name) => title.includes(name.toLowerCase()))
      continue
    }
    if (active) out.push(line)
  }
  return out.join('\n')
}

function parseProjectDispatchStrategy(line: string): ProjectModelDispatchStrategy | undefined {
  const lower = line.toLowerCase()
  if (hasAny(lower, ['成本优先', '低成本优先', 'cost-first', 'cost first', 'strategy: cost', 'strategy=cost'])) return 'cost'
  if (hasAny(lower, ['质量优先', '强推理优先', 'quality-first', 'quality first', 'strategy: quality', 'strategy=quality'])) {
    return 'quality'
  }
  if (hasAny(lower, ['速度优先', 'speed-first', 'speed first', 'strategy: speed', 'strategy=speed'])) return 'speed'
  if (hasAny(lower, ['均衡', 'balanced', 'strategy: balanced', 'strategy=balanced'])) return 'balanced'
  return undefined
}

function parseDispatchTarget(line: string): Omit<ProjectModelDispatchTarget, 'source'> | undefined {
  const providerId = matchTargetValue(line, ['provider', 'providerId', '厂商'])
  const model = matchTargetValue(line, ['model', '模型'])
  if (providerId || model) return cleanTarget({ providerId, model })
  const slash = line.match(/(?:^|[\s:：])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:@-]+)/)
  if (slash) return cleanTarget({ providerId: slash[1], model: slash[2] })
  return undefined
}

function matchTargetValue(line: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const match = line.match(new RegExp(`${escapeRegExp(key)}\\s*[:=：]\\s*([^\\s,，;；]+)`, 'i'))
    if (match?.[1]) return match[1]
  }
  return undefined
}

function cleanTarget(target: { providerId?: string; model?: string }): Omit<ProjectModelDispatchTarget, 'source'> | undefined {
  const providerId = target.providerId?.trim()
  const model = target.model?.trim()
  if (!providerId && !model) return undefined
  return { providerId, model }
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle.toLowerCase()))
}

function renderDetectedStack(detected: ProjectDetectedStack): string {
  const lines: string[] = ['# 自动识别项目栈']
  if (detected.techStack.length > 0) lines.push(`- 技术栈: ${detected.techStack.join(', ')}`)
  if (detected.packageName) lines.push(`- package.json: ${detected.packageName}`)
  if (detected.packageManager) lines.push(`- 包管理器: ${detected.packageManager}`)
  if (detected.nodeScripts.length > 0) {
    lines.push('- 常用 npm scripts:')
    for (const item of detected.nodeScripts.slice(0, 12)) lines.push(`  - ${item.name}: ${item.command}`)
  }
  if (detected.dependencies.length > 0) {
    lines.push('- 关键依赖:')
    for (const item of detected.dependencies.slice(0, 24)) {
      lines.push(`  - ${item.name}@${item.version} (${item.scope})`)
    }
  }
  if (detected.python) {
    lines.push(`- Python: ${detected.python.projectName ?? 'pyproject.toml'}`)
    for (const dep of detected.python.dependencies.slice(0, 12)) lines.push(`  - ${dep}`)
  }
  if (detected.go) {
    lines.push(`- Go module: ${detected.go.module ?? 'go.mod'}${detected.go.version ? ` (go ${detected.go.version})` : ''}`)
  }
  if (detected.rust) {
    lines.push(`- Rust crate: ${detected.rust.packageName ?? 'Cargo.toml'}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function matchTomlString(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)
  return match?.[1]?.trim()
}

function matchTomlArray(text: string, key: string): string[] {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(text)
  if (!match) return []
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1])
}

function extractTomlSectionKeys(text: string, section: string): string[] {
  const sectionMatch = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|\\s*$)`, 'm').exec(text)
  if (!sectionMatch) return []
  return sectionMatch[1]
    .split(/\r?\n/)
    .map((line) => line.split('=')[0]?.trim())
    .filter((line): line is string => Boolean(line && !line.startsWith('#')))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
