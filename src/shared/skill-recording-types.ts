export interface SkillRecordingSource { id: string; name: string; kind: 'window' | 'screen' }
export interface SkillRecordingStep {
  id: string
  action: string
  outcome: string
  capturedAt: number
  image?: { previewDataUrl: string; width: number; height: number }
}
export interface SkillRecordingView {
  id: string
  phase: 'recording' | 'review'
  name: string
  description: string
  allowScreenshots: boolean
  temporary: boolean
  startedAt: number
  steps: SkillRecordingStep[]
  markdown?: string
}
export interface SkillRecordingBeginInput { name: string; description: string; consent: true; allowScreenshots: boolean }
export interface SkillRecordingSaveResult { path: string; name: string; imageCount: number; enabled: boolean; activationError?: string }
export interface SkillRecordingApi {
  beginSkillRecording(input: SkillRecordingBeginInput): Promise<SkillRecordingView>
  addSkillRecordingStep(recordingId: string, input: { action: string; outcome: string }): Promise<SkillRecordingView>
  removeSkillRecordingStep(recordingId: string, stepId: string): Promise<SkillRecordingView>
  listSkillRecordingSources(recordingId: string): Promise<SkillRecordingSource[]>
  captureSkillRecordingStep(recordingId: string, stepId: string, source: SkillRecordingSource): Promise<SkillRecordingView>
  removeSkillRecordingImage(recordingId: string, stepId: string): Promise<SkillRecordingView>
  stopSkillRecording(recordingId: string): Promise<SkillRecordingView>
  saveSkillRecording(recordingId: string, markdown: string, reviewed: true): Promise<SkillRecordingSaveResult>
  cancelSkillRecording(recordingId: string): Promise<void>
}
