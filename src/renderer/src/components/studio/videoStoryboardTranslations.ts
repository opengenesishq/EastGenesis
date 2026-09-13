export function videoStoryboardText(zh: boolean) {
  return zh ? {
    summary: '导演分镜 · 生成可编辑草稿',
    explanation: '根据剧本、角色设定和创作要求，自动选择文本模型规划镜头。核对并采用后才创建新结构版本。',
    duration: '目标时长（秒）', instructions: '导演创作要求',
    placeholder: '例如：保持同一主角，先全景后特写，结尾留出字幕时间。',
    busy: '处理中…', generate: '生成导演草稿', stop: '停止生成', apply: '采用为新结构版本',
    shotDuration: '时长（秒）', scene: '场景', shot: '镜头', title: '标题', content: '内容',
    scenes: '个场景', shots: '个镜头', seconds: '秒', taskTitle: '导演分镜'
  } : {
    summary: 'Director storyboard · Create an editable draft',
    explanation: 'Automatically route a text model to plan shots from your script, characters and direction. Review and adopt the draft to create a new structure version.',
    duration: 'Target length (seconds)', instructions: 'Creative direction',
    placeholder: 'For example: keep the same lead character, start wide, then close up, and leave room for the final caption.',
    busy: 'Working…', generate: 'Generate director draft', stop: 'Stop generation', apply: 'Adopt as a new structure version',
    shotDuration: 'Length (seconds)', scene: 'Scene', shot: 'Shot', title: 'title', content: 'content',
    scenes: 'scenes', shots: 'shots', seconds: 'seconds', taskTitle: 'Director storyboard'
  }
}
