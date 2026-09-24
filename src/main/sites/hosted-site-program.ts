import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { SiteDeploymentTarget } from '../../shared/site-deployment-types'
import { hostedDigest } from './hosted-site-protocol'
import { siteExecutableDigest } from './site-deployment-process'

/** Bind script entry files too when the configured executable is an interpreter. */
export async function hostedProgramDigest(target: SiteDeploymentTarget, cwd: string): Promise<string> {
  const executable = await siteExecutableDigest(target.executable)
  const interpreter = /^(?:node(?:js)?|python[\d.]*|ruby|perl|(?:ba|z|da)?sh|pwsh|powershell)(?:\.exe)?$/i.test(basename(target.executable))
  const scripts: Array<{ index: number; path: string; digest: string }> = []
  for (const [index, arg] of (target.management?.args ?? []).entries()) {
    if (arg.startsWith('-') || (!interpreter && !/\.(?:[cm]?js|py|rb|pl|sh|bash|zsh|ps1|ts)$/i.test(extname(arg)))) continue
    try {
      const path = await realpath(resolve(cwd, arg)), info = await lstat(path)
      if (!info.isFile()) continue
      if (info.size > 16 * 1024 * 1024 || scripts.length >= 16) throw new Error('管理适配器脚本入口过大或过多。')
      scripts.push({ index, path, digest: createHash('sha256').update(await readFile(path)).digest('hex') })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error }
  }
  return hostedDigest({ executable, scripts })
}
