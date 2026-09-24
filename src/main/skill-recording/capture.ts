import { desktopCapturer, systemPreferences } from 'electron'
import type { SkillRecordingSource } from '../../shared/skill-recording-types'
import { getQuickbarWindowContext } from '../quickbar'
import type { RecordedImage } from './recording'

export async function listRecordingSources(): Promise<SkillRecordingSource[]> {
  const context = await getQuickbarWindowContext()
  if (!context.ok) throw new Error('无法列出示范窗口。请检查屏幕录制权限，或继续记录文字。')
  return context.windows.map(source => ({ id: source.id, name: source.name, kind: source.kind }))
}

/** Same explicit source selection as Appshots, but keep pixels in memory until Save. */
export async function captureRecordingSource(selected: SkillRecordingSource): Promise<RecordedImage> {
  if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
    throw new Error('系统未允许屏幕录制。可以授权后重试，也可以继续记录文字。')
  }
  const sources = await desktopCapturer.getSources({ types: [selected.kind], thumbnailSize: { width: 1920, height: 1080 }, fetchWindowIcons: false })
  const source = sources.find(source => source.id === selected.id && source.name === selected.name)
  if (!source || source.thumbnail.isEmpty()) throw new Error('所选窗口已变化或截图为空。请刷新来源后重试，或继续记录文字。')
  const image = source.thumbnail.resize({ width: Math.min(1440, source.thumbnail.getSize().width) })
  const size = image.getSize()
  return { bytes: image.toPNG(), previewDataUrl: image.resize({ width: Math.min(720, size.width) }).toDataURL(), width: size.width, height: size.height }
}
