import { videoStoryboardText } from './videoStoryboardTranslations'
import { useRef, useState } from 'react'
import { useStore } from '../../store'
import { generateNativeDraft } from '../../lib/nativeDraft'
import type { VideoProduction } from '../../../../shared/media-types'
import { parseVideoStoryboardText, type VideoStoryboardDraft, type VideoStoryboardShotDraft } from '../../../../shared/video-storyboard-types'

interface DraftReview {
  draft: VideoStoryboardDraft
  sessionId: string
  revision: number
  script: string
}

export default function VideoStoryboardPlanner({ production, onApplied }: {
  production: VideoProduction
  onApplied: () => void | Promise<void>
}): React.JSX.Element {
  const text = videoStoryboardText(useStore((state) => state.settings.language) === 'zh')
  const [instructions, setInstructions] = useState('')
  const [duration, setDuration] = useState(30)
  const [review, setReview] = useState<DraftReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const generate = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    const controller = new AbortController()
    abort.current = controller
    try {
      const result = await generateNativeDraft(window.agentDesk, {
        title: `${production.title} · ${text.taskTitle}`, businessLineId: production.businessLineId ?? 'video', signal: controller.signal,
        prompt: storyboardPrompt(production, instructions, duration),
        onSession: (id) => { void useStore.getState().syncSession(id) }
      })
      setReview({ draft: parseVideoStoryboardText(result.text), sessionId: result.sessionId, revision: production.revision, script: production.script })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false); abort.current = null }
  }
  const apply = async (): Promise<void> => {
    if (!review || busy) return
    setBusy(true); setError('')
    try {
      await window.agentDesk.reviseVideoProduction({ productionId: production.id, script: review.script,
        storyboardDraft: review.draft, expectedRevision: review.revision })
      setReview(null); await onApplied()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <details className="video-storyboard-planner" data-video-storyboard-planner>
    <summary>{text.summary}</summary>
    <p>{text.explanation}</p>
    <label>{text.duration}<input className="input" type="number" min={5} max={3600} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>
    <textarea className="input" aria-label={text.instructions} placeholder={text.placeholder} value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={4000} />
    <div className="video-studio-inline-actions">
      <button type="button" className="btn btn-secondary btn-sm" data-video-storyboard-generate disabled={busy || duration < 5 || duration > 3600} onClick={() => void generate()}>{busy ? text.busy : text.generate}</button>
      {busy && <button type="button" className="btn btn-ghost btn-sm" onClick={() => abort.current?.abort()}>{text.stop}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {review && <StoryboardReview review={review} busy={busy} onChange={(draft) => setReview({ ...review, draft })} onApply={() => void apply()} />}
  </details>
}

function StoryboardReview({ review, busy, onChange, onApply }: {
  review: DraftReview; busy: boolean; onChange: (draft: VideoStoryboardDraft) => void; onApply: () => void
}): React.JSX.Element {
  const text = videoStoryboardText(useStore((state) => state.settings.language) === 'zh')
  const shots = review.draft.scenes.flatMap((scene) => scene.shots)
  const updateShot = (sceneIndex: number, shotIndex: number, patch: Partial<VideoStoryboardShotDraft>): void => {
    onChange({ ...review.draft, scenes: review.draft.scenes.map((scene, i) => i === sceneIndex
      ? { ...scene, shots: scene.shots.map((shot, j) => j === shotIndex ? { ...shot, ...patch } : shot) } : scene) })
  }
  return <div data-video-storyboard-review>
    <p>{review.draft.scenes.length} {text.scenes} · {shots.length} {text.shots} · {(shots.reduce((sum, shot) => sum + shot.durationMs, 0) / 1000).toFixed(1)} {text.seconds}</p>
    {review.draft.scenes.map((scene, i) => <fieldset key={i} disabled={busy}>
      <legend>{scene.title}</legend><p>{scene.summary}</p>
      {scene.shots.map((shot, j) => <div className="video-storyboard-draft-shot" key={j}>
        <input className="input" aria-label={`${text.scene} ${i + 1} ${text.shot} ${j + 1} ${text.title}`} value={shot.title} onChange={(event) => updateShot(i, j, { title: event.target.value })} />
        <textarea className="input" aria-label={`${text.scene} ${i + 1} ${text.shot} ${j + 1} ${text.content}`} value={shot.prompt} onChange={(event) => updateShot(i, j, { prompt: event.target.value })} />
        <label>{text.shotDuration}<input className="input" type="number" min={0.5} max={120} step={0.5} value={shot.durationMs / 1000} onChange={(event) => updateShot(i, j, { durationMs: Math.round(Number(event.target.value) * 1000) })} /></label>
      </div>)}
    </fieldset>)}
    <button type="button" className="btn btn-primary btn-sm" data-video-storyboard-apply disabled={busy} onClick={onApply}>{text.apply}</button>
  </div>
}

function storyboardPrompt(production: VideoProduction, instructions: string, duration: number): string {
  return [
    '你是视频导演。只返回符合下列格式的 JSON 分镜草稿；不要调用工具，不要伪造已经生成的视频或素材。',
    '{"schemaVersion":1,"scenes":[{"title":"场景名称","summary":"场景目的与连续性","shots":[{"title":"镜头名称","prompt":"主体、动作、景别、机位、运镜、光线、连续性与音画要求","durationMs":5000}]}]}',
    '每个镜头时长 500–120000 毫秒。完整覆盖剧本的情节，角色设定前后一致；不能无故跳过结尾。最多 100 场景/300 镜头。总时长尽量符合目标，宁可说明必要调整也不要堆砌重复镜头。不要包含 JSON 之外的解释。',
    `目标总时长：${duration} 秒。创作要求：${instructions || '清晰、连贯、可执行'}`,
    `角色设定：${JSON.stringify(production.characterBibles.map(({ name, summary, appearanceRules, voiceRules, behaviorRules }) => ({ name, summary, appearanceRules, voiceRules, behaviorRules })))}`,
    `剧本：\n${production.script}`
  ].join('\n\n')
}
