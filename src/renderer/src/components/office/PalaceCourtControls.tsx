import { COURT_STAGES, getCourtFrame, getCourtParticipantCount } from './court-ceremony'
import './palace-court-ceremony.css'

export interface PalaceCourtControlsProps {
  zh: boolean
  elapsed: number
  participants: number
  paused: boolean
  speed: number
  onPause(): void
  onReplay(): void
  onSpeed(speed: number): void
  onSkip(): void
  onClose(): void
  reducedMotion: boolean
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export default function PalaceCourtControls({
  zh, elapsed, participants, paused, speed, onPause, onReplay, onSpeed, onSkip, onClose, reducedMotion,
}: PalaceCourtControlsProps): React.JSX.Element {
  const frame = getCourtFrame(elapsed, participants)
  const stageIndex = COURT_STAGES.findIndex(stage => stage.id === frame.stage)
  const stage = COURT_STAGES[stageIndex]
  const completed = frame.stage === 'complete'
  const position = Math.min(frame.totalDuration, Math.max(0, Number.isNaN(elapsed) ? 0 : elapsed))
  const count = getCourtParticipantCount(participants)

  return <section className="palace-court-controls no-drag" data-palace-court-controls data-court-stage={frame.stage}
    aria-label={zh ? '朝会动画播放控制' : 'Court audience playback'} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }}>
    <header className="palace-court-controls-heading">
      <strong>{zh ? '上朝 · 常朝演示' : 'Court audience'}</strong>
      <span className="palace-court-controls-status" role="status">{completed ? (zh ? '已结束' : 'Complete') : paused ? (zh ? '已暂停' : 'Paused') : (zh ? '进行中' : 'Playing')}</span>
      <button className="palace-court-close" type="button" onClick={onClose} data-court-close
        aria-label={zh ? '离开朝会' : 'Leave court audience'} title={zh ? '离开朝会' : 'Leave court audience'}>×</button>
    </header>

    <p className="palace-court-motion-note">{zh ? '按明代常朝典制简化，礼节次数与人物数量经过压缩。' : 'A shortened presentation of Ming court protocol.'}</p>
    <div className="palace-court-stage-current" role="status">
      <span>{zh ? stage.zh : stage.en}</span>
      {frame.stage === 'report' && <small>{zh ? `第 ${frame.reportIndex + 1} / ${count} 位` : `${frame.reportIndex + 1} of ${count}`}</small>}
    </div>
    <ol className="palace-court-stage-list" aria-label={zh ? '朝会阶段' : 'Audience stages'}>
      {COURT_STAGES.filter(item => item.id !== 'complete').map((item, index) => <li key={item.id}
        aria-current={item.id === frame.stage ? 'step' : undefined}
        className={index < stageIndex ? 'is-complete' : item.id === frame.stage ? 'is-current' : undefined}>
        <span aria-hidden="true" />{zh ? item.zh : item.en}
      </li>)}
    </ol>
    <div className="palace-court-progress">
      <progress value={position} max={frame.totalDuration} aria-label={zh ? '朝会动画进度' : 'Audience animation progress'} />
      <span>{clock(position)} / {clock(frame.totalDuration)}</span>
    </div>

    <div className="palace-court-playback-buttons">
      <button type="button" disabled={completed} onClick={onPause} data-court-pause>
        {paused ? (zh ? '继续' : 'Resume') : (zh ? '暂停' : 'Pause')}
      </button>
      <button type="button" onClick={onReplay} data-court-replay>{zh ? '重播' : 'Replay'}</button>
      <div className="palace-court-speed" role="group" aria-label={zh ? '播放速度' : 'Playback speed'}>
        {[1, 2].map(value => <button key={value} type="button" onClick={() => onSpeed(value)}
          aria-pressed={speed === value} data-court-speed={value}>{value}×</button>)}
      </div>
    </div>
    <button type="button" className="palace-court-open-work" onClick={onSkip} data-court-open-work>
      {zh ? '直接处理任务' : 'Open court business'}<span aria-hidden="true">↗</span>
    </button>
    {reducedMotion && <p className="palace-court-motion-note">{zh ? '已启用减少动态效果' : 'Reduced motion is enabled'}</p>}
  </section>
}
