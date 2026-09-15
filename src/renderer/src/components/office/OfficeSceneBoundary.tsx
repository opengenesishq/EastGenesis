import { Component, type ReactNode } from 'react'
import './office-scene-recovery.css'

/** A renderer failure must not unmount the task panels outside this boundary. */
export default class OfficeSceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): ReactNode { return this.state.failed ? this.props.fallback : this.props.children }
}

export function OfficeSceneRecovery({ zh, onRetry, contextLost = false }: { zh: boolean; onRetry(): void; contextLost?: boolean }): React.JSX.Element {
  return <div className={`office-scene-recovery no-drag${contextLost ? ' office-scene-context-lost' : ''}`} role="status">
    <p>{zh ? '故宫场景暂时无法显示。仍可使用快捷入口、当前任务面板，或切回现代工作台继续工作。'
      : 'The palace scene is unavailable. Continue with the shortcuts, current task panel, or modern workspace.'}</p>
    <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{zh ? '重新加载场景' : 'Reload scene'}</button>
  </div>
}
