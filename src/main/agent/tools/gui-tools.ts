import { createGuiController } from '../../gui/gui-controller'
import {
  captureGuiVisualBaseline,
  normalizeGuiPostcondition,
  verifyGuiPostcondition,
  verifyGuiVisualPostcondition,
  type GuiPostcondition
} from '../../gui/gui-postcondition'
import type { ToolDefinition, ToolExecResult } from './tool-types'

export const GUI_TOOL_NAMES = [
  'gui_list_windows',
  'gui_activate_window',
  'gui_screenshot',
  'gui_click',
  'gui_type',
  'gui_scroll',
  'gui_hotkey'
] as const

export type GuiToolName = (typeof GUI_TOOL_NAMES)[number]

const GUI_TOOL_SET = new Set<string>(GUI_TOOL_NAMES)

export function isGuiToolName(name: string): name is GuiToolName {
  return GUI_TOOL_SET.has(name)
}

const WINDOW_SELECTOR_SCHEMA = {
  windowId: { type: 'string', description: 'gui_list_windows 返回的窗口 id' },
  title: { type: 'string', description: '窗口标题的部分匹配文本' },
  processName: { type: 'string', description: '进程名的部分匹配文本' },
  pid: { type: 'number', description: '进程 id' }
} satisfies Record<string, Record<string, unknown>>

const ELEMENT_SELECTOR_SCHEMA = {
  elementId: { type: 'string', description: 'gui_list_windows(includeElements=true) 返回的元素 id' },
  elementName: { type: 'string', description: '元素名称/可访问性 Name 的部分匹配文本' },
  automationId: { type: 'string', description: '元素 AutomationId 的部分匹配文本' },
  className: { type: 'string', description: '元素 ClassName 的部分匹配文本' },
  controlType: { type: 'string', description: '元素 ControlType 的部分匹配文本,例如 Edit/Button/ListItem' },
  elementIndex: { type: 'number', description: '元素列表中的 index' },
  maxElements: { type: 'number', description: '元素定位时最多扫描的元素数，默认 80，最大 300' }
} satisfies Record<string, Record<string, unknown>>

const GUI_POSTCONDITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: '动作后的可验证条件；未达到时工具返回失败，不把动作调用成功冒充任务成功。',
  properties: {
    kind: { type: 'string', enum: ['window', 'element', 'visual'], description: '验证窗口、可访问性元素或同一窗口的视觉变化' },
    state: {
      type: 'string',
      enum: ['exists', 'absent', 'enabled', 'disabled', 'visible', 'hidden', 'changed', 'unchanged'],
      description: 'window 支持 exists/absent；element 支持可访问性状态；visual 支持 changed/unchanged'
    },
    ...WINDOW_SELECTOR_SCHEMA,
    ...ELEMENT_SELECTOR_SCHEMA,
    sourceId: { type: 'string', description: '可选；visual 使用的精确 desktopCapturer source id' },
    minimumChangedRatio: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'changed 的最小变化像素比例' },
    maximumChangedRatio: { type: 'number', minimum: 0, maximum: 1, description: 'unchanged 的最大变化像素比例' },
    pixelDifferenceThreshold: { type: 'number', minimum: 0, maximum: 255, description: '单通道像素差阈值，默认 16' },
    timeoutMs: { type: 'number', minimum: 0, maximum: 5000, description: '等待上限，默认 1500ms' },
    intervalMs: { type: 'number', minimum: 50, maximum: 1000, description: '轮询间隔，默认 150ms' }
  },
  required: ['kind', 'state']
} satisfies Record<string, unknown>

export const GUI_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'gui_list_windows',
      description:
        '列出当前桌面可见窗口。Windows/macOS 可选 includeElements=true 返回可访问性元素摘要，供后续点击/输入按 selector 定位。GUI 自动化属于高风险能力，调用前必须获得用户审批。',
      parameters: {
        type: 'object',
        properties: {
          ...WINDOW_SELECTOR_SCHEMA,
          includeElements: { type: 'boolean', description: '是否返回匹配窗口的可访问性元素摘要，默认 false' },
          maxElements: { type: 'number', description: '每个窗口最多返回的元素数，默认 80，最大 300' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gui_activate_window',
      description: '按窗口 id、标题、进程名或 pid 激活桌面窗口。GUI 自动化属于高风险能力，调用前必须获得用户审批。',
      parameters: {
        type: 'object',
        properties: {
          ...WINDOW_SELECTOR_SCHEMA,
          postcondition: GUI_POSTCONDITION_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gui_screenshot',
      description:
        '截取当前屏幕或指定源并保存到项目 .caogen/tmp/gui/screenshots。默认返回保存路径、源信息；macOS 会附带屏幕录制权限状态，空截图会 fail-closed。',
      parameters: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', description: '可选 desktopCapturer source id' },
          savePath: { type: 'string', description: '可选；工作目录内的保存路径' },
          maxWidth: { type: 'number', description: '可选；缩略图最大宽度，默认 1440' },
          includeOcr: {
            type: 'boolean',
            description: '是否对截图执行本机 OCR(macOS Vision/tesseract 可用时返回文本)，默认 false'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gui_click',
      description:
        '点击屏幕坐标，或在 Windows/macOS 上按窗口/元素 selector 定位后点击。GUI 自动化属于高风险能力，调用前必须获得用户审批。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '屏幕绝对 X 坐标；使用元素 selector 时可省略' },
          y: { type: 'number', description: '屏幕绝对 Y 坐标；使用元素 selector 时可省略' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
          ...WINDOW_SELECTOR_SCHEMA,
          ...ELEMENT_SELECTOR_SCHEMA,
          postcondition: GUI_POSTCONDITION_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gui_type',
      description:
        '向当前激活窗口输入文本；Windows/macOS 可先按元素 selector 聚焦目标元素。GUI 自动化属于高风险能力，调用前必须获得用户审批。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本' },
          ...WINDOW_SELECTOR_SCHEMA,
          ...ELEMENT_SELECTOR_SCHEMA,
          postcondition: GUI_POSTCONDITION_SCHEMA
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gui_scroll',
      description:
        '滚动当前鼠标位置、指定坐标，或按窗口/元素 selector 定位后滚动。deltaY>0 表示向下滚动，deltaY<0 表示向上滚动；deltaX 用于水平滚动。GUI 自动化属于高风险能力，调用前必须获得用户审批。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '可选；屏幕绝对 X 坐标' },
          y: { type: 'number', description: '可选；屏幕绝对 Y 坐标' },
          deltaX: { type: 'number', description: '可选；水平滚动量，正数向右，负数向左' },
          deltaY: { type: 'number', description: '可选；垂直滚动量，正数向下，负数向上，默认 360' },
          ...WINDOW_SELECTOR_SCHEMA,
          ...ELEMENT_SELECTOR_SCHEMA,
          postcondition: GUI_POSTCONDITION_SCHEMA
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gui_hotkey',
      description:
        '向明确选择的窗口或当前激活窗口发送快捷键，例如 ["ctrl","shift","p"] 或 ["cmd","s"]。提供 window selector 时会先绑定目标；GUI 自动化属于高风险能力，调用前必须获得用户审批。',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: '快捷键按键序列'
          },
          ...WINDOW_SELECTOR_SCHEMA,
          postcondition: GUI_POSTCONDITION_SCHEMA
        },
        required: ['keys']
      }
    }
  }
]

export async function executeGuiTool(
  name: GuiToolName,
  args: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal
): Promise<ToolExecResult> {
  if ((name === 'gui_list_windows' || name === 'gui_screenshot') && args.postcondition !== undefined) {
    throw new Error(`${name} 是观察工具，不接受 postcondition`)
  }
  const postcondition = normalizeGuiPostcondition(args.postcondition)
  if (postcondition?.kind === 'visual' && !sharesExactWindowSelector(args, postcondition)) {
    throw new Error('visual postcondition 必须与 GUI 动作共享同一窗口 selector')
  }
  const controller = createGuiController(cwd)
  switch (name) {
    case 'gui_list_windows':
      return result(
        await controller.listWindows({
          ...windowSelector(args),
          includeElements: booleanValue(args.includeElements),
          maxElements: numberValue(args.maxElements)
        })
      )
    case 'gui_activate_window':
      return verifiedResult(() => controller.activateWindow(windowSelector(args)), postcondition, controller, signal)
    case 'gui_screenshot':
      return screenshotResult(await controller.screenshot({
        sourceId: stringValue(args.sourceId),
        savePath: stringValue(args.savePath),
        maxWidth: numberValue(args.maxWidth),
        includeOcr: booleanValue(args.includeOcr)
      }))
    case 'gui_click':
      return verifiedResult(
        () => controller.click({
          ...windowSelector(args),
          ...elementSelector(args),
          x: numberValue(args.x),
          y: numberValue(args.y),
          button: buttonValue(args.button)
        }),
        postcondition,
        controller,
        signal
      )
    case 'gui_type':
      return verifiedResult(
        () => controller.typeText({
          ...windowSelector(args),
          ...elementSelector(args),
          text: requiredString(args.text, 'text')
        }),
        postcondition,
        controller,
        signal
      )
    case 'gui_scroll':
      return verifiedResult(
        () => controller.scroll({
          ...windowSelector(args),
          ...elementSelector(args),
          x: numberValue(args.x),
          y: numberValue(args.y),
          deltaX: numberValue(args.deltaX),
          deltaY: numberValue(args.deltaY)
        }),
        postcondition,
        controller,
        signal
      )
    case 'gui_hotkey':
      return verifiedResult(
        () => controller.hotkey({ ...windowSelector(args), keys: requiredStringArray(args.keys, 'keys') }),
        postcondition,
        controller,
        signal
      )
  }
}

function result<T extends { ok: boolean }>(value: T): ToolExecResult {
  return { ok: value.ok, output: JSON.stringify(value, null, 2) }
}

function screenshotResult(value: Awaited<ReturnType<ReturnType<typeof createGuiController>['screenshot']>>): ToolExecResult {
  const base = result(value)
  if (!value.ok || !value.path) return base
  return {
    ...base,
    producedArtifacts: [{
      kind: 'screenshot',
      title: value.sourceName ? `GUI screenshot: ${value.sourceName}` : 'GUI screenshot',
      path: value.path,
      lineageKey: `gui-screenshot:${value.sourceId ?? value.sourceName ?? 'default'}`,
      producer: 'gui_screenshot',
      mediaType: 'image/png',
      metadata: {
        sourceId: value.sourceId,
        sourceName: value.sourceName,
        captureSha256: value.captureSha256,
        capturedAt: value.capturedAt,
        width: value.width,
        height: value.height
      },
      evidenceKind: 'observation',
      evidenceSummary: 'The desktop GUI controller captured a non-empty PNG output for this Run.',
      evidenceVerifier: 'gui-runtime'
    }]
  }
}

async function verifiedResult(
  runAction: () => Promise<{ ok: boolean; error?: string }>,
  postcondition: GuiPostcondition | undefined,
  controller: ReturnType<typeof createGuiController>,
  signal?: AbortSignal
): Promise<ToolExecResult> {
  if (!postcondition) {
    const action = await runAction()
    return result({ ...action, verification: { status: 'not_requested' } })
  }
  const baseline = postcondition.kind === 'visual'
    ? await captureGuiVisualBaseline((input) => controller.captureVisual(input), postcondition, signal)
    : undefined
  if (baseline && 'error' in baseline) {
    return result({
      ok: false,
      error: baseline.error,
      verification: { status: 'not_run', reason: 'baseline_failed' }
    })
  }
  const action = await runAction()
  if (!action.ok) return result({ ...action, verification: { status: 'not_run', reason: 'action_failed' } })
  const verification = baseline?.ok
    ? await verifyGuiVisualPostcondition(
        (input) => controller.captureVisual(input),
        postcondition,
        baseline.baseline,
        signal
      )
    : await verifyGuiPostcondition(
        (input) => controller.listWindows(input),
        postcondition,
        signal
      )
  return verification.status === 'passed'
    ? result({ ...action, verification })
    : result({ ...action, ok: false, error: verification.error, verification })
}

function windowSelector(args: Record<string, unknown>) {
  return {
    windowId: stringValue(args.windowId),
    title: stringValue(args.title),
    processName: stringValue(args.processName),
    pid: numberValue(args.pid)
  }
}

function sharesExactWindowSelector(args: Record<string, unknown>, postcondition: GuiPostcondition): boolean {
  for (const key of ['windowId', 'title', 'processName'] as const) {
    const actionValue = stringValue(args[key])
    const expectedValue = postcondition[key]
    if (actionValue && expectedValue && actionValue.toLocaleLowerCase() === expectedValue.toLocaleLowerCase()) return true
  }
  return typeof args.pid === 'number' && Number.isInteger(args.pid) && args.pid > 0 && args.pid === postcondition.pid
}

function elementSelector(args: Record<string, unknown>) {
  return {
    elementId: stringValue(args.elementId),
    elementName: stringValue(args.elementName),
    automationId: stringValue(args.automationId),
    className: stringValue(args.className),
    controlType: stringValue(args.controlType),
    elementIndex: numberValue(args.elementIndex),
    maxElements: numberValue(args.maxElements)
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} 不能为空`)
  return value
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是字符串数组`)
  const keys = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (keys.length === 0) throw new Error(`${name} 至少需要一个按键`)
  return keys.map((key) => key.trim())
}

function buttonValue(value: unknown): 'left' | 'right' | 'middle' {
  return value === 'right' || value === 'middle' ? value : 'left'
}
