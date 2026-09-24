import React, { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { taskWindowSessionId } from './task-window-context'
import 'highlight.js/styles/github-dark.css'
import './styles.css'

const App = lazy(() => import('./App'))
const TaskWindowApp = lazy(() => import('./TaskWindowApp'))
const DesktopCompanionApp = lazy(() => import('./components/companion/DesktopCompanionApp'))
const GuiPreviewApp = lazy(() => import('./components/gui-preview/GuiPreviewApp'))

const container = document.getElementById('root')
const detachedSessionId = taskWindowSessionId()
if (container) {
  const content = window.guiPreview
    ? <GuiPreviewApp />
    : window.desktopCompanion
    ? <DesktopCompanionApp />
    : detachedSessionId
      ? <TaskWindowApp sessionId={detachedSessionId} />
      : <App />
  createRoot(container).render(
    <React.StrictMode>
      <Suspense fallback={<div className="office-loading">加载中…</div>}>{content}</Suspense>
    </React.StrictMode>
  )
}
