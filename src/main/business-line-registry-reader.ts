import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getBusinessLines, type BusinessLineSettings } from '../shared/business-line-types'
import { resolveProjectWorkspaceRoot } from './project-workspace/persistence'

/** Command boundaries read only the registry in their explicit data root; stores stay independent of Electron. */
export function assertActiveBusinessLine(id: string, rootDir?: string): void {
  const registry = readRegistry(resolveProjectWorkspaceRoot(rootDir))
  if (!getBusinessLines(registry).some((line) => line.id === id && line.enabled)) throw new Error(`业务线不存在或已停用：${id}`)
}

function readRegistry(rootDir: string): BusinessLineSettings {
  try {
    const raw = JSON.parse(readFileSync(join(rootDir, 'settings.json'), 'utf8'))
    return { businessLines: Array.isArray(raw.businessLines) ? raw.businessLines : undefined }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('无法读取业务线注册表；请修复配置后再创建任务')
  }
}
