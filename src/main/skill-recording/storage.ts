import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SkillRecordingSaveResult } from '../../shared/skill-recording-types'
import { writeDurableFileSync } from '../durable-file'
import { testSkillMarkdown } from '../skill/skill-tester'
import { approvePluginRegistryItem, readPluginRegistryState, scanPluginRegistry, setPluginRegistryItemEnabled, writePluginRegistryState } from '../pluginRegistry'

/** Save only the reviewed Markdown and explicitly collected PNGs in a new personal skill folder. */
export function saveRecordedSkill(home: string, statePath: string, name: string, markdown: string, images: Array<{ filename: string; bytes: Uint8Array }>): SkillRecordingSaveResult {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63) throw new Error('技能目录名无效。')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!frontmatter || !/^name:\s*\S.*$/m.test(frontmatter[1]) || !/^description:\s*\S.*$/m.test(frontmatter[1])) throw new Error('SKILL.md 须保留 name 和 description 元数据。')
  const checked = testSkillMarkdown(markdown, { scope: 'global', maxBytes: 128 * 1024 })
  if (!checked.ok || checked.skill?.name !== name) throw new Error(checked.skill?.name !== name ? '请保留开始录制时的 name；修改显示说明可以编辑 description。' : checked.diagnostics.filter(item => item.severity === 'error').map(item => item.message).join(' '))
  // Keep the same lexical home root as defaultSkillRoots/Plugin Registry (macOS /var aliases can differ).
  const anchor = resolve(home)
  realpathSync(anchor)
  const extensionRoot = join(anchor, '.caogen'), root = join(extensionRoot, 'skills')
  directory(extensionRoot); directory(root)
  const target = join(root, name), written: string[] = []
  try { mkdirSync(target, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('同名技能已存在。请取消后更换名称，不会覆盖现有技能。')
    throw error
  }
  const created = lstatSync(target)
  let assetsCreated = false
  try {
    if (images.length) { mkdirSync(join(target, 'assets'), { mode: 0o700 }); assetsCreated = true }
    for (const image of images) {
      if (!/^step-[1-9][0-9]?\.png$/.test(image.filename)) throw new Error('示范图片名称无效。')
      const file = join(target, 'assets', image.filename)
      writeDurableFileSync(file, image.bytes, { mode: 0o600, replace: false }); written.push(file)
    }
    const path = join(target, 'SKILL.md')
    writeDurableFileSync(path, markdown, { mode: 0o600, replace: false }); written.push(path)
  } catch (error) {
    const current = lstatSync(target)
    if (!current.isSymbolicLink() && current.ino === created.ino && current.dev === created.dev) {
      for (const path of written.reverse()) { try { unlinkSync(path) } catch { /* Retain any unexpected filesystem changes. */ } }
      if (assetsCreated) { try { rmdirSync(join(target, 'assets')) } catch { /* Preserve unexpected files. */ } }
      try { rmdirSync(target) } catch { /* Preserve unexpected files. */ }
    }
    throw error
  }
  const result = { path: join(target, 'SKILL.md'), name, imageCount: images.length }
  try {
    const state = readPluginRegistryState(statePath)
    const view = scanPluginRegistry([extensionRoot], { maxFiles: 5000, maxDepth: 8, maxReadBytes: 256 * 1024 }, state)
    const item = view.items.find(item => item.kind === 'skill' && resolve(item.path) === target)
    if (!item) throw new Error('saved skill was not discovered')
    const approved = approvePluginRegistryItem(state, item)
    writePluginRegistryState(statePath, setPluginRegistryItemEnabled(approved, item, true))
    return { ...result, enabled: true }
  } catch {
    return { ...result, enabled: false, activationError: '技能文件已保存，但启用未完成。请在插件与技能目录刷新后审核并启用该技能。' }
  }
}

function directory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('个人技能目录必须是真实目录，不能使用符号链接。')
}
