import { ipcRenderer } from 'electron'
import type { TaskBudgetApi } from '../shared/task-budget-types'

export const taskBudgetApi: TaskBudgetApi = {
  getTaskBudget: id => ipcRenderer.invoke('taskBudget:get', id)
}
