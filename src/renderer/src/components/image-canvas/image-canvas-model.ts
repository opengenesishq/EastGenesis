import type { PreviewAnnotation } from '../../../../shared/types'
import type { TaskImageDraft } from '../../../../shared/image-canvas-types'
import type { ComposerDraftAddition } from '../../store/composer-draft-inbox'
export interface NormalizedImageBox { x: number; y: number; width: number; height: number }
export function normalizedImageBox(start: { x: number; y: number }, end: { x: number; y: number }): NormalizedImageBox {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  const left = Math.min(clamp(start.x), clamp(end.x)), top = Math.min(clamp(start.y), clamp(end.y))
  return { x: left, y: top, width: Math.max(clamp(start.x), clamp(end.x)) - left, height: Math.max(clamp(start.y), clamp(end.y)) - top }
}
/** Real image objects stay in payload.images; prose only describes identity and requested edits. */
export function imageCanvasDraftAddition(draft: TaskImageDraft, request: string, annotations: Record<string, PreviewAnnotation[]>, zh: boolean): ComposerDraftAddition {
  if (!draft.images.length || !draft.references.length || draft.references.some(ref => !draft.images.some(image => image.id === ref.attachmentId && `sha256:${image.hash}` === ref.digest))) throw new Error('图片附件与来源摘要不一致。')
  const sections = draft.references.map((reference, index) => {
    const notes = (annotations[reference.imageId] ?? []).map((annotation, noteIndex) => {
      const box = annotation.boundingBox
      const region = box ? (zh ? `区域（从左上角起，按原图百分比）：x=${percent(box.x)}%, y=${percent(box.y)}%, 宽=${percent(box.width)}%, 高=${percent(box.height)}%` : `Region (% from top-left): x=${percent(box.x)}, y=${percent(box.y)}, width=${percent(box.width)}, height=${percent(box.height)}`) : (zh ? '整张图片' : 'Whole image')
      return `${noteIndex + 1}. ${region}\n${annotation.note}`
    })
    return [ `${zh ? '图片' : 'Image'} ${index + 1}: ${reference.title}`,
      `${zh ? '附件' : 'Attachment'}: ${reference.attachmentId}`, `${zh ? '内容摘要' : 'Content digest'}: ${reference.digest}`,
      reference.sourcePath ? `${zh ? '原文件' : 'Source file'}: ${reference.sourcePath}` : '',
      reference.artifactId ? `${zh ? '成果版本' : 'Artifact version'}: ${reference.artifactId} / v${reference.version}` : '', ...notes ].filter(Boolean).join('\n')
  })
  return { payload: { text: [zh ? '请根据以下要求编辑所附图片，保留原图并创建修改后的版本。' : 'Edit the attached images as requested below. Preserve the originals and create revised versions.', request.trim(), ...sections].filter(Boolean).join('\n\n'), images: draft.images }, imagePreviews: draft.imagePreviews,
    imageNames: Object.fromEntries(draft.references.map(reference => [reference.attachmentId, reference.title])) }
}
function percent(value: number): string { return (value * 100).toFixed(1) }
