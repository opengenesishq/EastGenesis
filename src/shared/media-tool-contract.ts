export const MEDIA_TOOL_NAMES = ['inspect_media', 'create_video_production', 'submit_media_job', 'advance_media_job', 'reconcile_media_job'] as const
export type MediaToolName = typeof MEDIA_TOOL_NAMES[number]
export const MEDIA_AGENT_OPERATIONS = ['image.generate', 'image.edit', 'video.text-to-video', 'video.image-to-video', 'video.reference-to-video', 'speech.synthesize'] as const

export function isMediaToolName(name: string): name is MediaToolName {
  return MEDIA_TOOL_NAMES.some((candidate) => candidate === name)
}

/** These exact operations already own durable local identity or a MediaJob
 * effect barrier. Delegation never classifies them as permission-read-only. */
export function isDownstreamMediaEffectTool(name: string): boolean {
  return isMediaToolName(name) && name !== 'inspect_media'
}
