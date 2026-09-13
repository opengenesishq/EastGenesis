import { cpus } from 'node:os'
import type { CommandLine } from 'electron'

/** Keep hardware acceleration while avoiding the observed Graphite/Dawn
 * IOSurface scheduling stall on Intel macOS. Explicit backend choices win. */
export function configureGpuCompatibility(
  commandLine: Pick<CommandLine, 'hasSwitch' | 'getSwitchValue' | 'appendSwitch'>,
  platform: string = process.platform,
  cpuModels: readonly string[] = cpus().map((cpu) => cpu.model)
): boolean {
  if (platform !== 'darwin' || !cpuModels.some((model) => /\bIntel\b/i.test(model))) return false
  if (['disable-gpu', 'use-angle', 'use-gl'].some((name) => commandLine.hasSwitch(name))) return false
  const enabled = featureList(commandLine.getSwitchValue('enable-features'))
  const disabled = featureList(commandLine.getSwitchValue('disable-features'))
  if (enabled.some(isGraphite) || disabled.some(isGraphite)) return false
  commandLine.appendSwitch('disable-features', [...disabled, 'SkiaGraphite'].join(','))
  return true
}

function featureList(value: string): string[] {
  return value.split(',').map((feature) => feature.trim()).filter(Boolean)
}

function isGraphite(feature: string): boolean {
  return feature.split(/[<:]/, 1)[0] === 'SkiaGraphite'
}
