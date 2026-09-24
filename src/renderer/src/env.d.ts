/// <reference types="vite/client" />
import type { AgentDeskApi } from '../../shared/types'
import type { GuiPreviewApi } from '../../shared/gui-preview-types'
import type { DesktopCompanionApi, DesktopCompanionWorkbenchApi } from '../../shared/desktop-companion-types'

declare global {
  interface Window {
    agentDesk: AgentDeskApi
    guiPreview?: GuiPreviewApi
    desktopCompanion?: DesktopCompanionApi
    desktopCompanionWorkbench?: DesktopCompanionWorkbenchApi
  }
}

export {}
