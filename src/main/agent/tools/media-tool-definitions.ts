import type { ToolDefinition } from './tool-types'
import { MEDIA_AGENT_OPERATIONS } from '../../../shared/media-tool-contract'

const target = { type: 'string', description: 'inspect_media 返回的目标 ID；省略时复用已配置厂商自动路由。' }
const jobId = { type: 'string', description: '当前项目与业务线内的媒体任务 ID。' }
const parameters = {
  type: 'object', additionalProperties: false,
  properties: { durationSeconds: { type: 'number', minimum: 1, maximum: 60 },
    aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] }, quality: { type: 'string', enum: ['draft', 'standard', 'high'] } }
}

export const MEDIA_TOOLS: ToolDefinition[] = [
  { type: 'function', function: { name: 'inspect_media',
    description: '只读查看可用媒体能力、当前项目和业务线的制作、镜头、任务、产物与费用。不会请求厂商。',
    parameters: { type: 'object', additionalProperties: false, properties: { productionId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } } } } },
  { type: 'function', function: { name: 'create_video_production',
    description: '在当前项目及业务线创建可检查的制作草稿和镜头。仅执行策略可用；不会调用厂商。项目归属和幂等身份由当前会话注入。',
    parameters: { type: 'object', additionalProperties: false,
      properties: { title: { type: 'string', maxLength: 240 }, script: { type: 'string', maxLength: 20000 } }, required: ['title', 'script'] } } },
  { type: 'function', function: { name: 'submit_media_job',
    description: '为当前制作提交一个图片、视频或语音任务。自动或指定已配置目标；执行前预留会话/月度/制作预算，复用已有素材外发授权。返回任务 ID；结果未知时必须对账，不能换目标重发。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      productionId: { type: 'string' }, shotId: { type: 'string' }, operation: { type: 'string', enum: [...MEDIA_AGENT_OPERATIONS] },
      mediaProviderId: target, prompt: { type: 'string', maxLength: 20000 }, inputAssetIds: { type: 'array', maxItems: 16, items: { type: 'string' } },
      voice: { type: 'string' }, parameters,
      routingPreference: { type: 'string', enum: ['balanced', 'quality', 'cost', 'speed'] }
    }, required: ['productionId', 'operation', 'prompt'] } } },
  { type: 'function', function: { name: 'advance_media_job',
    description: '推进已提交任务一次：使用原连接查询进度或获取产物，不重新提交、不切换厂商。返回状态和已注册 Artifact。结果未知时改用 reconcile_media_job。',
    parameters: { type: 'object', additionalProperties: false, properties: { jobId }, required: ['jobId'] } } },
  { type: 'function', function: { name: 'reconcile_media_job',
    description: '仅对结果未知的已提交任务查询原厂商；没有可核实的厂商任务 ID 时保持等待。不会重新生成或释放未核实费用。',
    parameters: { type: 'object', additionalProperties: false, properties: { jobId }, required: ['jobId'] } } }
]
