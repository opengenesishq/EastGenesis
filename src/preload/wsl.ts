import { ipcRenderer } from 'electron'
import type { WslApi } from '../shared/wsl-types'
export const wslApi: WslApi = {
  inspectWsl: () => ipcRenderer.invoke('wsl:inspect'),
  validateWslDirectory: input => ipcRenderer.invoke('wsl:validate-directory', input)
}
