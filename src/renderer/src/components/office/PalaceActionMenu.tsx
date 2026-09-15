import { PALACE_ACTIONS, type PalaceAction } from './palaceActions'

export default function PalaceActionMenu({ zh, onAction }: { zh: boolean; onAction(action: PalaceAction): void }): React.JSX.Element {
  return <details className="palace-action-menu" data-palace-action-menu>
    <summary className="office-camera-button">{zh ? '宫廷动作' : 'Palace actions'}</summary>
    <div>{PALACE_ACTIONS.map((action) => <button key={action.id} type="button" className="office-camera-button"
      data-palace-action={action.id} onClick={(event) => {
        event.currentTarget.closest('details')?.removeAttribute('open')
        onAction(action.id)
      }}>{zh ? action.label : action.labelEn}</button>)}</div>
  </details>
}
