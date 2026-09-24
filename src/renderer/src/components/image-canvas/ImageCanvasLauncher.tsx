import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
const ImageCanvas = lazy(() => import('./ImageCanvas'))
export interface ImageCanvasLauncherProps {
  sessionId: string
  initialAttachmentId?: string
  children?: ReactNode
  title?: string
  ariaLabel?: string
  className?: string
}
export default function ImageCanvasLauncher({ sessionId, initialAttachmentId, children, title, ariaLabel, className }: ImageCanvasLauncherProps): React.JSX.Element {
  const [openFor, setOpenFor] = useState<string | null>(null)
  useEffect(() => { setOpenFor(null) }, [sessionId])
  return <>
    <button type="button" className={className ?? 'btn btn-ghost btn-sm'} title={title} aria-label={ariaLabel ?? title ?? '图片工作台'} data-image-canvas-launcher onClick={() => setOpenFor(sessionId)}>{children ?? '图片'}</button>
    {openFor === sessionId && <Suspense fallback={<span role="status">正在打开图片…</span>}><ImageCanvas key={sessionId} sessionId={sessionId} initialAttachmentId={initialAttachmentId} onClose={() => setOpenFor(null)} onDraftStaged={() => setOpenFor(null)} /></Suspense>}
  </>
}
