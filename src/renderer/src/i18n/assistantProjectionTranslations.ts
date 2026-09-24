export const ASSISTANT_PROJECTION_TRANSLATIONS = {
  assistantComputeReady: { zh: '已自动准备执行资源', en: 'Ready to start automatically' },
  assistantComputeCheckingLocal: { zh: '正在查找本机模型', en: 'Checking for local models' },
  assistantComputeUnavailableShort: { zh: '未连接模型', en: 'No model connected' },
  assistantComputeUnavailable: {
    zh: '当前没有可用的执行资源。完成设置后可以从这里继续。',
    en: 'No execution service is available. Finish setup, then continue here.'
  },
  assistantLocalRuntimeMissing: {
    zh: '未检测到本地执行服务。安装后可继续当前任务。',
    en: 'No local execution service was found. Install one to continue this task.'
  },
  assistantLocalRuntimeStartFailed: {
    zh: '已检测到本地执行服务，但自动启动失败。打开后重新检查。',
    en: 'A local execution service was found but could not be started. Open it, then check again.'
  },
  assistantLocalModelMissing: {
    zh: '本地执行服务已启动，但任务资源尚未准备好。完成下载或加载后可继续当前任务。',
    en: 'The local execution service is running, but its task resource is not ready. Finish downloading or loading it to continue.'
  },
  assistantInstallOllama: { zh: '安装本地服务', en: 'Install local service' },
  assistantBrowseOllamaModels: { zh: '浏览本地资源', en: 'Browse local resources' },
  assistantStartFailed: {
    zh: '任务暂时无法开始。请检查可用服务后重试，当前内容不会被发送。',
    en: 'The task could not start. Check available services and retry; nothing was sent.'
  },
  assistantWorkspaceUnavailable: {
    zh: '当前工作位置不可用。请重新选择后再试。',
    en: 'This workspace is unavailable. Choose it again and retry.'
  },
  assistantPresetNeedsWorkspace: {
    zh: '这个任务需要项目目录。请选择已有项目，或浏览一个文件夹；当前内容尚未发送。',
    en: 'This task needs a project folder. Choose an existing project or browse for a folder; nothing has been sent yet.'
  },
  assistantChooseWorkspace: { zh: '选择项目文件夹', en: 'Choose project folder' },
  assistantComputeCheckFailed: {
    zh: '暂时无法检查可用服务。请稍后重试。',
    en: 'Available services could not be checked. Try again shortly.'
  },
  assistantConfigureCompute: { zh: '设置可用服务', en: 'Set up a service' },
  assistantRetryCompute: { zh: '重新检查', en: 'Check again' },
  assistantCheckingCompute: { zh: '检查中…', en: 'Checking…' },
  assistantAutoCompute: { zh: '执行资源由系统自动选择', en: 'Execution is selected automatically' },
  assistantRoutingStatus: { zh: '已自动选择合适的执行资源', en: 'A suitable service was selected automatically' },
  assistantFailoverStatus: {
    zh: '服务短暂不可用，已自动继续',
    en: 'A service was unavailable; work continued automatically'
  }
} as const
