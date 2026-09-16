import { createHash } from 'node:crypto'
import { beginCodeForgeVerification, finishCodeForgeVerification, type CodeForgeVerificationCapture } from './code-forge/verification-evidence'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import { formalFileWriteGuard } from './permission/limited-file-execution'
import { assertPreparationToolScope, isPreparationTool, resolvePreparationToolScope, type PreparationToolPermission } from './permission/preparation-tool-scope'
import { withDataLifecycleMutation } from './data-lifecycle/data-lifecycle-mutation-lock'
import { assertPreparationSessionNotDeleted } from './permission/preparation-permission-lifecycle'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import {
  runLocalCommand,
  writeTextFileLocally,
  type LocalCommandResult,
  type LocalFileWritePrecondition
} from './sandbox/local-execution'
import {
  formatSearchReplaceResult,
  runExactFileEdit,
  runSearchReplace,
  searchReplacementArgs
} from './agent/tools/search-replace'
import { GUI_TOOLS } from './agent/tools/gui-tools'
import { formatViewResult, runView } from './agent/tools/view'
import { formatSearchSymbolResult, runSearchSymbol } from './agent/tools/search-symbol'
import { formatSearchCodeResult, runSearchCode } from './agent/tools/search-code'
import { formatFindFileResult, runFindFile } from './agent/tools/find-file'
import { formatDependenciesResult, runGetDependencies } from './agent/tools/get-dependencies'
import { GIT_TOOLS, executeGitTool, isGitToolName } from './agent/tools/git-tools'
import { BROWSER_TOOLS } from './agent/tools/browser-tools'
import { P2_TOOLS, executeP2Tool, isP2ToolName } from './agent/tools/p2-tools'
import { MEDIA_TOOLS } from './agent/tools/media-tool-definitions'
import { OFFICE_REVISION_TOOLS } from './agent/tools/office-revision-tools'
import { executeContextBoundTool } from './agent/tools/context-bound-tools'
import type { ToolDefinition } from './agent/tools/tool-types'
export type { ToolDefinition } from './agent/tools/tool-types'
import {
  CREATE_DOCUMENT_TOOL,
  CREATE_PDF_TOOL,
  CREATE_PRESENTATION_TOOL,
  CREATE_SPREADSHEET_TOOL
} from './agent/tools/office-artifact'
import { clipToolOutput } from './agent/tool-output'
import type { CodeForgeWorktreeContext } from './code-forge/delivery'
import type { ToolProducedArtifactDescriptor } from './agent/tools/tool-types'
import {
  GENESIS_ORCHESTRATE_TOOL_NAME,
  type GenesisOrchestrationInput
} from './genesis/orchestrator'
import { buildGenesisPlanContract } from './task/genesis-plan-contract'
import { resolveExistingProjectPathSync, resolveWritableProjectPathSync } from './utils/safe-project-path'
import { OPENAI_PERMISSION_READ_ONLY_TOOLS, stableValueDigest } from './task/tool-idempotency'
import { SkillManager } from './skill/skill-manager'
import { searchMemories, type MemoryLayer } from './memory/memory-manager'
import { taskMemoryScope } from './memory/task-memory-scope'
import { resolveMemoryRoot } from './memory/memory-root'
import { proposeModelMemoryDraft } from './learning/memory-tool-adapter'
import {
  builtinMcpServerTemplates,
  callMcpTool,
  discoverMcpServer,
  type McpServerConfig
} from './mcp/mcp-client'
import {
  executeMcpEffectTarget,
  mcpServerConfigFromToolInput,
  recordApprovedMcpDiscovery
} from './mcp/mcp-effect'
import {
  authorizeMcpRuntimeConfig,
  authorizeSkillRuntime
} from './plugin/plugin-runtime-authorization'
import type {
  CommandTermination,
  EngineKind,
  EffectTarget,
  PermissionModeId,
  SandboxMode,
  SessionMeta,
  TaskDag,
  TaskDagDispatchInput,
  TaskDagDispatchResult,
  TaskDecomposeInput,
  TaskDecomposeResult,
  WorkflowArtifactKind
} from '../shared/types'

/**
 * OpenAI 引擎的原生工具集(让任何 Chat Completions 模型在 CaoGen 里
 * 成为真编码 Agent,而非聊天窗)。核心工具覆盖 bash / view / read_file /
 * write_file / search_replace / edit_file / list_dir。
 *
 * 安全边界:
 * - 文件操作限定在会话 cwd 内(路径牢笼,拒绝逃逸)
 * - bash 在会话 cwd 执行,120s 超时,输出截断
 * - 权限审批由引擎层按 permissionMode 决定,这里只负责执行
 */

export interface ToolExecResult {
  ok: boolean
  output: string
  exitCode?: number; commandTermination?: CommandTermination
  sandboxMode?: SandboxMode
  modeUsed?: SandboxMode
  sandboxed?: boolean
  fallbackReason?: string
  /** Main-process only; stripped after canonical Artifact registration. */
  producedArtifacts?: ToolProducedArtifactDescriptor[]
}
export interface ToolExecutionOptions {
  /** Main-owned live rule check; propagated into the final file/Office writer. */
  assertFormalWriteAuthorized?: () => void
  /** Main-owned version captured before approval; never supplied by model tool input. */
  taskExecutionAuthorityRevision?: number
  /** Main-owned immutable input digest captured before command approval. */
  commandInputDigest?: string
  preparationPermission?: PreparationToolPermission
  signal?: AbortSignal
  sandboxMode?: SandboxMode
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  sessionId?: string
  worktreeContext?: CodeForgeWorktreeContext
  effectTarget?: EffectTarget
  sessionMeta?: SessionMeta
  userDataRoot?: string
  toolUseId?: string
}

const READ_MAX_BYTES = 200 * 1024
const BASH_TIMEOUT_MS = 120_000
const LIST_MAX_ENTRIES = 500
const ARTIFACT_REGISTER_KINDS = new Set<WorkflowArtifactKind>([
  'report', 'source', 'requirement', 'design', 'document', 'spreadsheet',
  'presentation', 'pdf', 'code', 'patch', 'diff', 'test_report', 'screenshot',
  'pull_request', 'issue', 'release_package', 'custom'
])

/** Chat Completions 工具声明(发给模型的 schema) */
export const OPENAI_CODING_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        '在会话工作目录执行 shell 命令并返回 stdout/stderr/退出码。用于构建、测试、git、安装依赖等。120 秒超时。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          recordVerification: { type: 'boolean', description: '验证代码时设为 true：主进程记录执行前后源码版本与真实结果，供 code_forge_delivery 引用此调用 ID。' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作目录内一个文本文件的内容(最大 200KB)。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对或绝对路径(须在工作目录内)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view',
      description:
        '按行号查看工作目录内的文本文件片段,默认最多 200 行并带行号。会跳过二进制、压缩、source map、lockfile 和压缩生成文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '目标文件绝对路径或工作目录内相对路径' },
          start_line: { type: 'number', description: '起始行号,默认 1' },
          end_line: { type: 'number', description: '结束行号;未提供时读取 start_line 起 200 行' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或整体覆盖工作目录内的一个文件(自动创建父目录)。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: '完整文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'artifact_register',
      description:
        '把当前 Project 内已经生成的真实文件登记为 canonical Artifact，并自动写入版本、摘要、位置、Evidence、Artifact 级完整性 Acceptance、阶段交接与可恢复导出。适用于报告、需求、设计、代码、Diff、测试报告、截图、PR/Issue 回退包和发布安装包等成品。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '当前 Project 内已存在的非符号链接普通文件' },
          kind: {
            type: 'string',
            enum: [
              'report', 'source', 'requirement', 'design', 'document', 'spreadsheet',
              'presentation', 'pdf', 'code', 'patch', 'diff', 'test_report', 'screenshot',
              'pull_request', 'issue', 'release_package', 'custom'
            ]
          },
          title: { type: 'string', description: '结果工作台显示的成品标题' },
          lineageKey: { type: 'string', description: '可选稳定版本线标识；默认使用 Project 相对路径' },
          mediaType: { type: 'string', description: '可选 MIME type；默认按扩展名推断' },
          evidenceSummary: { type: 'string', description: '可选的交付证据摘要' }
        },
        required: ['path', 'kind', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: CREATE_DOCUMENT_TOOL,
      description:
        '在当前 Project 内生成可交付的 Word .docx 成品。输出禁止覆盖已有文件，并在审批后通过 Artifact、Evidence 和 Acceptance 链登记。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project 内的 .docx 输出路径' },
          title: { type: 'string', description: '文档标题' },
          headings: {
            type: 'array',
            items: { type: 'string' },
            description: '可选的一级标题列表'
          },
          paragraphs: {
            type: 'array',
            items: { type: 'string' },
            description: '正文段落列表'
          },
          source_refs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；Project 内实际使用的来源文件路径。未提供时由当前 Run/Effect 保留来源链。'
          }
        },
        required: ['path', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: CREATE_SPREADSHEET_TOOL,
      description:
        '在当前 Project 内生成可交付的 Excel .xlsx 成品。支持多工作表、标量单元格和带缓存结果的公式，输出禁止覆盖已有文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project 内的 .xlsx 输出路径' },
          title: { type: 'string', description: '工作簿标题' },
          sheets: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '工作表名称' },
                rows: {
                  type: 'array',
                  items: {
                    type: 'array',
                    items: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'number' },
                        { type: 'boolean' },
                        {
                          type: 'object',
                          properties: {
                            formula: { type: 'string' },
                            result: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] }
                          },
                          required: ['formula']
                        }
                      ]
                    }
                  }
                }
              },
              required: ['name', 'rows']
            }
          },
          source_refs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；Project 内实际使用的来源文件路径。未提供时由当前 Run/Effect 保留来源链。'
          }
        },
        required: ['path', 'title', 'sheets']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: CREATE_PRESENTATION_TOOL,
      description:
        '在当前 Project 内生成可交付的 PowerPoint .pptx 成品。支持多页标题、正文和项目符号，输出禁止覆盖已有文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project 内的 .pptx 输出路径' },
          title: { type: 'string', description: '演示文稿标题' },
          slides: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '页面标题' },
                body: { type: 'string', description: '可选正文' },
                bullets: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '可选项目符号列表'
                }
              },
              required: ['title']
            }
          },
          source_refs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；Project 内实际使用的来源文件路径。未提供时由当前 Run/Effect 保留来源链。'
          }
        },
        required: ['path', 'title', 'slides']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: CREATE_PDF_TOOL,
      description:
        '在当前 Project 内生成可交付的 PDF 成品。内置中文字体，支持章节和段落，输出禁止覆盖已有文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project 内的 .pdf 输出路径' },
          title: { type: 'string', description: 'PDF 标题' },
          sections: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: '可选章节标题' },
                paragraphs: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '章节正文段落'
                }
              }
            }
          },
          source_refs: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；Project 内实际使用的来源文件路径。未提供时由当前 Run/Effect 保留来源链。'
          }
        },
        required: ['path', 'title', 'sections']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_replace',
      description:
        '精准字符串替换工具。优先用它修改已有文件:old_str 必须包含足够上下文并唯一匹配;可批量替换、dry_run 预览 diff,写入前自动备份到 .caogen/tmp/backup。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '目标文件绝对路径或工作目录内相对路径' },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                old_str: { type: 'string', description: '要替换的原字符串,必须包含至少前后 3 行上下文以保证唯一匹配' },
                new_str: { type: 'string', description: '替换后的字符串' },
                replace_all: { type: 'boolean', description: '是否替换所有匹配项,默认 false' }
              },
              required: ['old_str', 'new_str']
            }
          },
          dry_run: { type: 'boolean', description: '仅预览 Diff 不实际修改,默认 false' }
        },
        required: ['file_path', 'replacements']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '兼容旧工具:精确字符串替换编辑文件。新任务应优先使用 search_replace,只有旧模型调用时才使用本工具。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: '是否替换所有精确匹配项,默认 false' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出工作目录内某个目录的条目(目录带 / 后缀,最多 500 条)。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "相对路径,默认 '.'" }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_symbol',
      description:
        '搜索项目索引中的函数、类、接口、方法、常量、类型或导出项,返回定义文件、行号和签名。开始修改前优先用它定位相关符号。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '符号名或部分名称' },
          kind: { type: 'string', description: '可选:function/class/interface/method/constant/type/export' },
          limit: { type: 'number', description: '返回数量上限,默认 20,最大 100' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        '基于 ripgrep 的项目全文代码搜索,返回匹配文件、行号和片段;rg 不可用时自动使用索引降级搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的字符串' },
          glob: { type: 'string', description: '可选 glob,例如 src/**/*.ts' },
          limit: { type: 'number', description: '返回数量上限,默认 20,最大 100' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_file',
      description: '按文件名或路径片段在项目索引中模糊查找文件。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '文件名或路径片段' },
          limit: { type: 'number', description: '返回数量上限,默认 20,最大 100' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dependencies',
      description: '查看一个文件的正向依赖、反向依赖和外部导入,修改前用它判断影响范围。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '目标文件绝对路径或工作目录内相对路径' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_decompose',
      description:
        '将复杂自然语言需求拆解为有依赖关系的 DAG 子任务。只生成计划,不启动子 Agent。复杂/跨模块需求应先调用它。',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: '用户原始需求或需要拆解的复杂任务' },
          useModel: { type: 'boolean', description: '是否允许使用强推理模型拆解;默认 true' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          providerId: { type: 'string', description: '可选:指定拆解模型 Provider' },
          model: { type: 'string', description: '可选:指定拆解模型' }
        },
        required: ['request']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: GENESIS_ORCHESTRATE_TOOL_NAME,
      description:
        '生成 Genesis 编排计划/执行报告:任务拆解、worker lanes、隔离 worktree 策略、验证 gates、风险/人工确认点和 Code Forge 交付策略。第一版只规划,不启动外部 Agent、不创建 worktree、不提交/推送。',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: '用户原始复杂任务或需要 Genesis 编排的目标' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          driveMode: { type: 'string', enum: ['spark', 'core', 'forge', 'command', 'genesis'] },
          validationCommands: {
            type: 'array',
            items: { type: 'string' },
            description: '计划中的验证命令;未传时从 package.json 推断 typecheck/build/test gates'
          },
          deliveryMode: {
            type: 'string',
            enum: ['report', 'patch', 'commit', 'pr'],
            description: '整体交付意图;默认 report。Code Forge 仅规划 report/patch，commit/pr 会拆为独立 Git 工具步骤。'
          },
          maxWorkerLanes: { type: 'number', description: '计划生成的 worker lane 上限,默认 8,最大 12' },
          isolationRoot: { type: 'string', description: '计划中的隔离 worktree 根目录;不会实际创建' },
          requireHumanConfirmation: { type: 'boolean', description: '是否强制在报告中列出人工确认 gate' }
        },
        required: ['request']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_dispatch_dag',
      description:
        '按给定 DAG 启动多 Agent 依赖调度。会创建 child sessions/worktrees 并开始执行;需要用户授权后再调用。',
      parameters: {
        type: 'object',
        properties: {
          dag: { type: 'object', description: 'task_decompose 返回的 dag 对象' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          isolated: { type: 'boolean', description: '是否使用独立 Git worktree;默认 true' },
          model: { type: 'string', description: '可选:子 Agent 模型' },
          providerId: { type: 'string', description: '可选:子 Agent Provider' },
          engine: { type: 'string', enum: ['claude', 'anthropic', 'gemini', 'openai'] },
          permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: '(deprecated) 收编后子会话 permissionMode 由 taskStrategy 派生，此参数被忽略。' },
          maxRetries: { type: 'number', description: '每个子任务失败后的最大重试次数,默认 2,最大 5' },
          taskTimeoutMs: { type: 'number', description: '单个子任务运行超时毫秒数;默认 20 分钟,<=0 关闭超时' },
          autoMerge: { type: 'boolean', description: '是否在 DAG 成功后自动合并 worktree;默认 false' },
          verificationCommand: { type: 'string', description: '自动合并后的验收命令' }
        },
        required: ['dag']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'task_decompose_and_dispatch_dag',
      description:
        '一站式拆解并启动 DAG 多 Agent 调度。适合用户明确要求并行推进的复杂任务;会创建 child sessions/worktrees。',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: '用户原始需求或需要拆解的复杂任务' },
          useModel: { type: 'boolean', description: '是否允许使用强推理模型拆解;默认 true' },
          cwd: { type: 'string', description: '可选项目目录;默认当前会话项目' },
          isolated: { type: 'boolean', description: '是否使用独立 Git worktree;默认 true' },
          model: { type: 'string', description: '可选:拆解和子 Agent 模型' },
          providerId: { type: 'string', description: '可选:拆解和子 Agent Provider' },
          engine: { type: 'string', enum: ['claude', 'anthropic', 'gemini', 'openai'] },
          permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'], description: '(deprecated) 收编后子会话 permissionMode 由 taskStrategy 派生，此参数被忽略。' },
          maxRetries: { type: 'number', description: '每个子任务失败后的最大重试次数,默认 2,最大 5' },
          taskTimeoutMs: { type: 'number', description: '单个子任务运行超时毫秒数;默认 20 分钟,<=0 关闭超时' },
          autoMerge: { type: 'boolean', description: '是否在 DAG 成功后自动合并 worktree;默认 false' },
          verificationCommand: { type: 'string', description: '自动合并后的验收命令' }
        },
        required: ['request']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: '列出当前项目和用户目录可用的结构化 Skill，可按 query 匹配最相关能力。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选，按任务描述匹配 Skill' },
          limit: { type: 'number', description: '返回数量上限，默认 12' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '读取一个结构化 Skill 的完整定义、步骤、触发词和验证说明。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id 或名称' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_skill',
      description: '按用户确认执行一个结构化 Skill。未传 confirmed=true 时只返回待确认步骤。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Skill id 或名称' },
          confirmed: { type: 'boolean', description: '用户确认后设为 true' },
          parameters: { type: 'object', description: '可选执行参数' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '检索 CaoGen 三层记忆(working/project/user)，用于恢复约定、偏好和项目事实。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索文本' },
          layers: {
            type: 'array',
            items: { type: 'string', enum: ['working', 'project', 'user'] },
            description: '可选层级，默认三层都查'
          },
          limit: { type: 'number', description: '返回数量上限，默认 8' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_add',
      description: '创建项目范围的待批准记忆草稿；不会直接写入生效记忆。仅提议稳定事实、偏好或明确约定。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', enum: ['working', 'project', 'user'] },
          title: { type: 'string' },
          body: { type: 'string' },
          source: { type: 'string', description: '来源说明，例如 session/user-confirmed' },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['layer', 'title', 'body', 'source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_discover',
      description: '按给定 stdio、HTTP 或 SSE MCP server 配置执行 initialize，并发现 tools/resources/prompts。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'stdio server 命令' },
          serverId: { type: 'string', description: 'Plugin Registry 中已批准且启用的 MCP server 名称' },
          args: { type: 'array', items: { type: 'string' } },
          url: { type: 'string', description: 'HTTP JSON-RPC 或 SSE endpoint' },
          transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
          timeoutMs: { type: 'number' }
        },
        required: ['serverId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_call_tool',
      description: '调用一个 MCP tool。普通调用按不可查询副作用保护；如已先执行 mcp_discover，可提供只读 reconciliation contract 以支持崩溃后自动对账。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          serverId: { type: 'string', description: 'Plugin Registry 中已批准且启用的 MCP server 名称' },
          args: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
          toolName: { type: 'string' },
          arguments: { type: 'object' },
          reconciliation: {
            type: 'object',
            description: '可选自动对账契约；toolName 必须由同一 MCP server 声明 annotations.readOnlyHint=true。',
            properties: {
              toolName: { type: 'string', description: '专用只读查询工具名。' },
              arguments: { type: 'object', description: '只读查询参数，不得包含凭据。' },
              jsonPointer: { type: 'string', description: '指向查询结果的 RFC 6901 JSON Pointer；文本 JSON 可从 /content/0/parsed 读取。' },
              expectedValue: { description: '确认副作用已发生时该位置的精确预期值。' }
            },
            required: ['toolName', 'jsonPointer', 'expectedValue']
          },
          timeoutMs: { type: 'number' }
        },
        required: ['serverId', 'toolName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_builtin_servers',
      description: '列出 CaoGen 内置的常用 MCP server 配置模板，供用户确认后启用。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  ...GIT_TOOLS,
  ...BROWSER_TOOLS,
  ...P2_TOOLS,
  ...MEDIA_TOOLS, ...OFFICE_REVISION_TOOLS,
  ...GUI_TOOLS
]

/** 只读工具(plan 模式仅放行这些;default 模式免审批) */
export const READONLY_TOOLS = OPENAI_PERMISSION_READ_ONLY_TOOLS
/** 文件写入类(acceptEdits 模式自动放行) */
export const EDIT_TOOLS = new Set([
  'write_file',
  'artifact_register',
  'search_replace',
  'edit_file',
  CREATE_DOCUMENT_TOOL,
  CREATE_SPREADSHEET_TOOL,
  CREATE_PRESENTATION_TOOL,
  CREATE_PDF_TOOL
])

/**
 * Responses API 的工具 schema(扁平形态:type/name/description/parameters 平铺,
 * 无 Chat Completions 的嵌套 function 对象)。由 OPENAI_CODING_TOOLS 派生,单一事实源。
 */
export const RESPONSES_CODING_TOOLS: Array<Record<string, unknown>> = OPENAI_CODING_TOOLS.map((t) => ({
  type: 'function',
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters
}))

/** 路径牢笼:解析到 cwd 内的真实路径;拒绝 symlink/junction 逃逸。 */
function jailExisting(cwd: string, rawPath: string): string {
  return resolveExistingProjectPathSync(cwd, rawPath).fullPath
}

function jailWritable(cwd: string, rawPath: string): string {
  return resolveWritableProjectPathSync(cwd, rawPath).fullPath
}

function clip(text: string): string {
  return clipToolOutput(text)
}

function stringArg(args: Record<string, unknown>, primary: string, fallback?: string): string {
  const first = args[primary]
  if (typeof first === 'string' && first.trim()) return first
  if (fallback) {
    const second = args[fallback]
    if (typeof second === 'string' && second.trim()) return second
  }
  throw new Error(`${primary} 不能为空`)
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

function memoryLayersArg(value: unknown): MemoryLayer[] | undefined {
  const items = stringArrayArg(value)
  if (!items) return undefined
  const allowed = new Set<MemoryLayer>(['working', 'project', 'user'])
  return items.filter((item): item is MemoryLayer => allowed.has(item as MemoryLayer))
}

function recordArg(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function authorizedMcpConfigArg(
  args: Record<string, unknown>,
  projectRoot: string
) {
  const requestedConfig = args.command !== undefined || args.url !== undefined
    ? mcpServerConfigFromToolInput(args)
    : undefined
  return authorizeMcpRuntimeConfig({
    projectRoot,
    serverId: stringArg(args, 'serverId'),
    requestedConfig
  })
}
function engineArg(value: unknown): EngineKind | undefined {
  return value === 'anthropic' || value === 'gemini' || value === 'openai' ? value : undefined
}

function permissionModeArg(value: unknown): PermissionModeId | undefined {
  return value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions'
    ? value
    : undefined
}

function sessionIdArg(options: ToolExecutionOptions): string {
  if (typeof options.sessionId === 'string' && options.sessionId.trim()) return options.sessionId
  throw new Error('DAG 任务工具需要当前 sessionId')
}

function taskDagArg(value: unknown): TaskDag {
  const record = recordArg(value)
  const tasks = record.tasks
  if (typeof record.id !== 'string' || !record.id.trim()) throw new Error('dag.id 不能为空')
  if (typeof record.title !== 'string' || !record.title.trim()) throw new Error('dag.title 不能为空')
  if (typeof record.source !== 'string') throw new Error('dag.source 必须是字符串')
  if (record.complexity !== 'single' && record.complexity !== 'multi') {
    throw new Error('dag.complexity 必须是 single 或 multi')
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    throw new Error('dag.createdAt 必须是数字时间戳')
  }
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('dag.tasks 至少需要一个任务')
  return record as unknown as TaskDag
}

function decomposeInputArgs(args: Record<string, unknown>, cwd: string): TaskDecomposeInput {
  const input: TaskDecomposeInput = {
    request: stringArg(args, 'request'),
    cwd: optionalStringArg(args.cwd) ?? cwd
  }
  if (typeof args.useModel === 'boolean') input.useModel = args.useModel
  const providerId = optionalStringArg(args.providerId)
  if (providerId) input.providerId = providerId
  const model = optionalStringArg(args.model)
  if (model) input.model = model
  return input
}

function dagDispatchInputArgs(args: Record<string, unknown>, dag: TaskDag, cwd: string): TaskDagDispatchInput {
  const input: TaskDagDispatchInput = {
    dag,
    cwd: optionalStringArg(args.cwd) ?? cwd
  }
  if (typeof args.isolated === 'boolean') input.isolated = args.isolated
  const model = optionalStringArg(args.model)
  if (model) input.model = model
  const providerId = optionalStringArg(args.providerId)
  if (providerId) input.providerId = providerId
  const engine = engineArg(args.engine)
  if (engine) input.engine = engine
  // P0 收编: 忽略模型传入的 permissionMode, 子会话 permissionMode 由 taskStrategy 派生。
  // permissionModeArg(args.permissionMode) 的结果不再写入 input。
  void args.permissionMode
  void permissionModeArg
  const maxRetries = numberArg(args.maxRetries)
  if (maxRetries !== undefined) input.maxRetries = maxRetries
  const taskTimeoutMs = numberArg(args.taskTimeoutMs)
  if (taskTimeoutMs !== undefined) input.taskTimeoutMs = taskTimeoutMs
  if (typeof args.autoMerge === 'boolean') input.autoMerge = args.autoMerge
  const verificationCommand = optionalStringArg(args.verificationCommand)
  if (verificationCommand) input.verificationCommand = verificationCommand
  return input
}

function genesisInputArgs(args: Record<string, unknown>, cwd: string): GenesisOrchestrationInput {
  const input: GenesisOrchestrationInput = {
    request: stringArg(args, 'request'),
    cwd: optionalStringArg(args.cwd) ?? cwd
  }
  const driveMode = genesisDriveModeArg(args.driveMode)
  if (driveMode) input.driveMode = driveMode
  const validationCommands = stringArrayArg(args.validationCommands)
  if (validationCommands) input.validationCommands = validationCommands
  const deliveryMode = genesisDeliveryModeArg(args.deliveryMode)
  if (deliveryMode) input.deliveryMode = deliveryMode
  const maxWorkerLanes = numberArg(args.maxWorkerLanes)
  if (maxWorkerLanes !== undefined) input.maxWorkerLanes = maxWorkerLanes
  const isolationRoot = optionalStringArg(args.isolationRoot)
  if (isolationRoot) input.isolationRoot = isolationRoot
  if (typeof args.requireHumanConfirmation === 'boolean') {
    input.requireHumanConfirmation = args.requireHumanConfirmation
  }
  return input
}

function genesisDriveModeArg(value: unknown): GenesisOrchestrationInput['driveMode'] | undefined {
  return value === 'spark' || value === 'core' || value === 'forge' || value === 'command' || value === 'genesis'
    ? value
    : undefined
}

function genesisDeliveryModeArg(value: unknown): GenesisOrchestrationInput['deliveryMode'] | undefined {
  return value === 'report' || value === 'patch' || value === 'commit' || value === 'pr' ? value : undefined
}

async function loadSessionManager() {
  const specifier = './sessionManager.js'
  return (await import(specifier) as { sessionManager: {
    decomposeTask(parentSessionId: string, input: TaskDecomposeInput): Promise<TaskDecomposeResult>
    dispatchTaskDag(parentSessionId: string, input: TaskDagDispatchInput): Promise<TaskDagDispatchResult>
  } }).sessionManager
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 执行一个工具调用;所有异常转为 ok:false 文本,绝不抛出打断 Agent 循环 */
export async function executeCodingTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  options: ToolExecutionOptions = {}
): Promise<ToolExecResult> {
  if (options.preparationPermission) {
    if (!isPreparationTool(name) || !options.sessionMeta || !options.userDataRoot) {
      return { ok: false, output: '此工具未适配独立准备区权限。' }
    }
    try { assertPreparationToolScope(options.sessionMeta, { cwd, preparation: options.preparationPermission }, options.userDataRoot, name) }
    catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error) } }
  }
  try {
    if (options.signal?.aborted) return { ok: false, output: '操作已中断' }
    if (name === 'bash' && options.commandInputDigest !== undefined && options.commandInputDigest !== stableValueDigest(args)) {
      return { ok: false, output: '执行前命令输入已变化，旧审批失效；请重新审批。', commandTermination: 'not_started' }
    }
    const assertFormalWriteAuthorized = formalFileWriteGuard(name, args, cwd, {
      preparation: Boolean(options.preparationPermission), sessionId: options.sessionId, effectTarget: options.effectTarget, rootDir: options.userDataRoot,
      sessionMeta: options.sessionMeta, taskExecutionAuthorityRevision: options.taskExecutionAuthorityRevision
    })
    assertFormalWriteAuthorized()
    options = { ...options, assertFormalWriteAuthorized }
    const contextBound = executeContextBoundTool(name, args, cwd, options)
    if (contextBound) return clipExecResult(await contextBound)
    if (isGitToolName(name)) {
      return clipExecResult(await executeGitTool(name, args, cwd, {
        sessionId: options.sessionId,
        userDataRoot: options.userDataRoot,
        worktreeContext: options.worktreeContext,
        effectTarget: options.effectTarget
      }))
    }
    if (isP2ToolName(name)) {
      return clipExecResult(await executeP2Tool(name, args, cwd, {
        effectTarget: options.effectTarget,
        sessionMeta: options.sessionMeta,
        userDataRoot: options.userDataRoot,
        toolUseId: options.toolUseId
      }))
    }
    switch (name) {
      case 'bash':
        return await runBash(String(args.command ?? ''), cwd, options, args)
      case 'read_file': {
        const p = jailExisting(cwd, String(args.path ?? ''))
        const stat = statSync(p)
        if (stat.size > READ_MAX_BYTES) {
          return { ok: false, output: `文件过大(${stat.size} 字节 > ${READ_MAX_BYTES}),请用 bash 工具分段查看` }
        }
        return { ok: true, output: clip(readFileSync(p, 'utf8')) }
      }
      case 'view': {
        const result = await runView(cwd, {
          file_path: stringArg(args, 'file_path', 'path'),
          start_line: numberArg(args.start_line),
          end_line: numberArg(args.end_line)
        })
        return { ok: result.ok, output: clip(formatViewResult(result)) }
      }
      case 'write_file': {
        const p = jailWritable(cwd, String(args.path ?? ''))
        const content = String(args.content ?? '')
        const guard = fileWritePrecondition(cwd, p, content, options.effectTarget)
        const writeResult = await localFileWrite(cwd, p, content, options, guard, name)
        return withExecutionMetadata(
          {
            ok: writeResult.ok,
            output: writeResult.ok
              ? `已写入 ${args.path}(${Buffer.byteLength(content)} 字节)\n${writeResult.output}`
              : writeResult.output
          },
          writeResult,
          options.sandboxMode
        )
      }
      case 'artifact_register': {
        const descriptor = artifactRegisterDescriptor(cwd, args)
        return {
          ok: true,
          output: `Artifact 待登记: ${descriptor.title} (${descriptor.kind})`,
          producedArtifacts: [descriptor]
        }
      }
      case 'search_replace': {
        let writeResult: LocalCommandResult | undefined
        const result = await runSearchReplace(cwd, {
          file_path: stringArg(args, 'file_path', 'path'),
          replacements: searchReplacementArgs(args.replacements),
          dry_run: args.dry_run === true
        }, {
          effectTarget: options.effectTarget?.kind === 'file_content' ? options.effectTarget : undefined,
          writeTextFile: async (filePath, content, guard) => {
            writeResult = await localFileWrite(cwd, filePath, content, options, guard, name)
            if (!writeResult.ok) throw new Error(writeResult.output)
          }
        })
        return withExecutionMetadata({ ok: result.ok, output: clip(formatSearchReplaceResult(result)) }, writeResult, options.sandboxMode)
      }
      case 'edit_file': {
        if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
          return { ok: false, output: 'edit_file 的 old_string 与 new_string 必须是字符串' }
        }
        if (args.replace_all !== undefined && typeof args.replace_all !== 'boolean') {
          return { ok: false, output: 'edit_file 的 replace_all 必须是布尔值' }
        }
        const oldStr = args.old_string
        const newStr = args.new_string
        let writeResult: LocalCommandResult | undefined
        const result = await runExactFileEdit(cwd, {
          file_path: stringArg(args, 'path', 'file_path'),
          old_string: oldStr,
          new_string: newStr,
          replace_all: args.replace_all === true
        }, {
          effectTarget: options.effectTarget?.kind === 'file_content' ? options.effectTarget : undefined,
          writeTextFile: async (filePath, content, guard) => {
            writeResult = await localFileWrite(cwd, filePath, content, options, guard, name)
            if (!writeResult.ok) throw new Error(writeResult.output)
          }
        })
        return withExecutionMetadata({ ok: result.ok, output: clip(formatSearchReplaceResult(result)) }, writeResult, options.sandboxMode)
      }
      case 'list_dir': {
        const p = jailExisting(cwd, String(args.path ?? '.'))
        const entries = readdirSync(p, { withFileTypes: true })
          .slice(0, LIST_MAX_ENTRIES)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return { ok: true, output: entries.join('\n') || '(空目录)' }
      }
      case 'search_symbol': {
        const result = await runSearchSymbol(cwd, {
          name: stringArg(args, 'name'),
          kind: optionalStringArg(args.kind),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(formatSearchSymbolResult(result)) }
      }
      case 'search_code': {
        const result = await runSearchCode(cwd, {
          query: stringArg(args, 'query'),
          glob: optionalStringArg(args.glob),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(formatSearchCodeResult(result)) }
      }
      case 'find_file': {
        const result = await runFindFile(cwd, {
          pattern: stringArg(args, 'pattern'),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(formatFindFileResult(result)) }
      }
      case 'get_dependencies': {
        const result = await runGetDependencies(cwd, {
          file_path: stringArg(args, 'file_path', 'path')
        })
        return { ok: true, output: clip(formatDependenciesResult(result)) }
      }
      case 'task_decompose': {
        const parentSessionId = sessionIdArg(options)
        const manager = await loadSessionManager()
        const result = await manager.decomposeTask(parentSessionId, decomposeInputArgs(args, cwd))
        return { ok: true, output: clip(JSON.stringify(result, null, 2)) }
      }
      case GENESIS_ORCHESTRATE_TOOL_NAME:
        return { ok: true, output: clip(JSON.stringify(await buildGenesisPlanContract(
          sessionIdArg(options), genesisInputArgs(args, cwd)), null, 2)) }
      case 'task_dispatch_dag': {
        const parentSessionId = sessionIdArg(options)
        const manager = await loadSessionManager()
        const result = await manager.dispatchTaskDag(
          parentSessionId,
          dagDispatchInputArgs(args, taskDagArg(args.dag), cwd)
        )
        return { ok: true, output: clip(JSON.stringify(result, null, 2)) }
      }
      case 'task_decompose_and_dispatch_dag': {
        const parentSessionId = sessionIdArg(options)
        const manager = await loadSessionManager()
        const decompose: TaskDecomposeResult = await manager.decomposeTask(parentSessionId, decomposeInputArgs(args, cwd))
        const dispatch = await manager.dispatchTaskDag(
          parentSessionId,
          dagDispatchInputArgs(args, decompose.dag, cwd)
        )
        return { ok: true, output: clip(JSON.stringify({ decompose, dispatch }, null, 2)) }
      }
      case 'list_skills': {
        const manager = new SkillManager({ projectRoot: cwd })
        const query = optionalStringArg(args.query)
        const limit = Math.max(1, Math.min(50, Math.floor(numberArg(args.limit) ?? 12)))
        const skills = query
          ? manager.match(query, 0.1).slice(0, limit).map((match) => ({
              id: match.skill.id,
              name: match.skill.name,
              description: match.skill.description,
              score: match.score,
              tags: match.skill.tags,
              sourcePath: match.skill.sourcePath
            }))
          : manager.list().slice(0, limit).map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              tags: skill.tags,
              sourcePath: skill.sourcePath
            }))
        return { ok: true, output: clip(JSON.stringify({ skills, diagnostics: manager.diagnosticsView() }, null, 2)) }
      }
      case 'load_skill': {
        const id = stringArg(args, 'id')
        const manager = new SkillManager({ projectRoot: cwd })
        const skill =
          manager.list().find((item) => item.id === id || item.name.toLowerCase() === id.toLowerCase()) ??
          manager.match(id, 0.1)[0]?.skill
        if (!skill) return { ok: false, output: `未找到 Skill: ${id}` }
        authorizeSkillRuntime(cwd, skill)
        return { ok: true, output: clip(manager.exportSkill(skill.id) ?? JSON.stringify(skill, null, 2)) }
      }
      case 'run_skill': {
        const id = stringArg(args, 'id')
        const manager = new SkillManager({ projectRoot: cwd })
        const skill =
          manager.list().find((item) => item.id === id || item.name.toLowerCase() === id.toLowerCase()) ??
          manager.match(id, 0.1)[0]?.skill
        if (!skill) return { ok: false, output: `未找到 Skill: ${id}` }
        authorizeSkillRuntime(cwd, skill)
        const executionPlan = {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          steps: skill.steps,
          verification: skill.verification,
          parameters: recordArg(args.parameters)
        }
        if (args.confirmed !== true) {
          return {
            ok: false,
            output: clip(JSON.stringify({ requiresConfirmation: true, message: '需要用户确认后才能执行 Skill。', skill: executionPlan }, null, 2))
          }
        }
        return { ok: true, output: clip(JSON.stringify({ status: 'confirmed', executionPlan, body: skill.body }, null, 2)) }
      }
      case 'memory_search': {
        const hits = await searchMemories(resolveMemoryRoot(options.userDataRoot), {
          query: stringArg(args, 'query'),
          ...(options.sessionMeta
            ? await taskMemoryScope(options.sessionMeta, options.userDataRoot ?? '')
            : { projectRoot: cwd, sessionId: options.sessionId }),
          layers: memoryLayersArg(args.layers),
          limit: numberArg(args.limit)
        })
        return { ok: true, output: clip(JSON.stringify({ hits }, null, 2)) }
      }
      case 'memory_add': {
        const entry = await proposeModelMemoryDraft(options.sessionMeta?.sourceCwd ?? options.sessionMeta?.cwd ?? cwd, args,
          { projectId: options.sessionMeta?.workspaceId, userDataRoot: options.userDataRoot })
        return { ok: true, output: clip(JSON.stringify(entry, null, 2)) }
      }
      case 'mcp_discover': {
        const timeoutMs = numberArg(args.timeoutMs)
        const authorized = authorizedMcpConfigArg(args, cwd)
        const result = await discoverMcpServer(authorized.config, timeoutMs)
        recordApprovedMcpDiscovery(authorized.publicConfig, authorized.binding, result)
        return { ok: true, output: clip(JSON.stringify(result, null, 2)) }
      }
      case 'mcp_call_tool': {
        const timeoutMs = numberArg(args.timeoutMs)
        if (options.effectTarget?.kind === 'mcp_tool_call') {
          const execution = await executeMcpEffectTarget(options.effectTarget, args, timeoutMs)
          return { ok: execution.ok, output: clip(JSON.stringify(execution, null, 2)) }
        }
        const authorized = authorizedMcpConfigArg(args, cwd)
        const result = await callMcpTool(
          authorized.config,
          stringArg(args, 'toolName', 'name'),
          recordArg(args.arguments),
          timeoutMs
        )
        return { ok: !result.isError, output: clip(JSON.stringify(result, null, 2)) }
      }
      case 'mcp_builtin_servers':
        return { ok: true, output: clip(JSON.stringify({ servers: builtinMcpServerTemplates() }, null, 2)) }
      default:
        return { ok: false, output: `未知工具: ${name}` }
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
}

function clipExecResult(result: ToolExecResult): ToolExecResult {
  return { ...result, output: clip(result.output) }
}

function artifactRegisterDescriptor(
  cwd: string,
  args: Record<string, unknown>
): ToolProducedArtifactDescriptor {
  const safe = resolveExistingProjectPathSync(cwd, stringArg(args, 'path'))
  const info = statSync(safe.fullPath)
  if (!info.isFile()) throw new Error('artifact_register path 必须是普通文件')
  const kind = args.kind
  if (typeof kind !== 'string' || !ARTIFACT_REGISTER_KINDS.has(kind as WorkflowArtifactKind)) {
    throw new Error('artifact_register kind 无效')
  }
  const title = boundedArtifactText(stringArg(args, 'title'), 'title', 240)
  const lineageKey = boundedArtifactText(
    optionalStringArg(args.lineageKey) ?? safe.relativePath,
    'lineageKey',
    2_048
  )
  const evidenceSummary = optionalStringArg(args.evidenceSummary)
  return {
    kind: kind as WorkflowArtifactKind,
    title,
    path: safe.fullPath,
    lineageKey,
    producer: 'artifact_register',
    mediaType: optionalStringArg(args.mediaType) ?? artifactMediaType(safe.fullPath),
    metadata: {
      projectRelativePath: safe.relativePath,
      sizeBytes: info.size
    },
    evidenceKind: kind === 'test_report' ? 'test_result' : 'delivery_check',
    evidenceSummary: evidenceSummary
      ? boundedArtifactText(evidenceSummary, 'evidenceSummary', 4_000)
      : `The registered ${kind} file is available and bound to its canonical digest and Project ownership.`,
    evidenceVerifier: 'artifact-register-runtime',
    requiredCanonicalRegistration: true
  }
}

function boundedArtifactText(value: string, label: string, maxLength: number): string {
  const clean = value.trim()
  if (!clean || clean.length > maxLength || /[\0-\x1f\x7f]/.test(clean)) {
    throw new Error(`artifact_register ${label} 无效`)
  }
  return clean
}

function artifactMediaType(path: string): string | undefined {
  const types: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json',
    '.html': 'text/html; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.patch': 'text/x-diff',
    '.diff': 'text/x-diff',
    '.zip': 'application/zip',
    '.dmg': 'application/x-apple-diskimage',
    '.pkg': 'application/vnd.apple.installer+xml'
  }
  return types[extname(path).toLowerCase()]
}

async function localFileWrite(
  cwd: string,
  targetPath: string,
  content: string,
  options: ToolExecutionOptions,
  guard: LocalFileWritePrecondition | undefined,
  toolName: string
): Promise<LocalCommandResult> {
  const assertResolvedTarget = formalFileWriteGuard(toolName, { path: targetPath, file_path: targetPath }, cwd, {
    preparation: Boolean(options.preparationPermission), rootDir: options.userDataRoot, sessionId: options.sessionId,
    sessionMeta: options.sessionMeta, taskExecutionAuthorityRevision: options.taskExecutionAuthorityRevision
  })
  const assertPreparation = () => {
    options.assertFormalWriteAuthorized?.()
    assertResolvedTarget()
    if (!options.preparationPermission) return
    if (!options.sessionMeta || !options.userDataRoot || !guard) throw new Error('准备区写入缺少当前任务、授权或冻结 Effect。')
    assertPreparationToolScope(options.sessionMeta, { cwd, preparation: options.preparationPermission }, options.userDataRoot)
  }
  const write = () => writeTextFileLocally({
    beforeGuardedCommit: assertPreparation,
    assertWriteAuthorized: assertPreparation,
    cwd,
    targetPath,
    content,
    expectedFile: guard,
    mode: options.sandboxMode ?? 'restrictedLocal',
    timeoutMs: BASH_TIMEOUT_MS,
    chinaMirrorEnabled: options.chinaMirrorEnabled,
    npmRegistry: options.npmRegistry,
    pipIndexUrl: options.pipIndexUrl,
    signal: options.signal
  })
  if (!options.preparationPermission) return options.sessionMeta && options.userDataRoot
    ? withDataLifecycleMutation(options.userDataRoot, async () => { assertPreparation(); return write() })
    : write()
  if (!options.sessionMeta || !options.userDataRoot || !guard) throw new Error('准备区写入缺少当前任务、授权或冻结 Effect。')
  const { sessionMeta, userDataRoot } = options
  return withDataLifecycleMutation(userDataRoot, async () => {
    assertPreparationSessionNotDeleted(userDataRoot, sessionMeta)
    const scope = resolvePreparationToolScope(sessionMeta, 'write_file', { path: targetPath }, userDataRoot)
    if (!scope.preparation || scope.cwd !== cwd) throw new Error('准备区写入目标已不属于当前任务授权。')
    assertPreparation()
    // Hold through every async mkdir/open/write so purge cannot finish and then
    // have an older writer recreate its directories. Keep the final guard too.
    return write()
  })
}

function fileWritePrecondition(
  cwd: string,
  targetPath: string,
  content: string,
  target: EffectTarget | undefined
): LocalFileWritePrecondition | undefined {
  if (!target) return undefined
  if (target.kind !== 'file_content') {
    throw new Error('write_file 缺少已冻结的文件效果目标')
  }
  const resolved = resolveWritableProjectPathSync(cwd, targetPath)
  if (
    target.rootPath !== resolved.root ||
    target.relativePath !== resolved.relativePath
  ) {
    throw new Error('write_file 目标路径与已批准 Effect 不一致')
  }
  if (target.rootIdentity) {
    const rootInfo = statSync(resolved.root, { bigint: true })
    if (
      rootInfo.dev.toString() !== target.rootIdentity.device ||
      rootInfo.ino.toString() !== target.rootIdentity.inode
    ) {
      throw new Error('write_file 项目根目录身份与已批准 Effect 不一致')
    }
  }
  const expected = Buffer.from(content, 'utf8')
  if (
    target.expectedBytes !== expected.byteLength ||
    target.expectedSha256 !== createHash('sha256').update(expected).digest('hex')
  ) {
    throw new Error('write_file 内容与已批准 Effect 不一致')
  }
  if (target.preState === 'absent') {
    if (!target.rootIdentity) {
      throw new Error('write_file 已批准 Effect 缺少项目根目录身份')
    }
    return {
      state: 'absent',
      rootPath: target.rootPath,
      rootIdentity: target.rootIdentity
    }
  }
  if (
    !target.preFileIdentity ||
    typeof target.preSha256 !== 'string' ||
    typeof target.preBytes !== 'number'
  ) {
    throw new Error('write_file 已批准 Effect 缺少现有文件前置条件')
  }
  return {
    state: 'file',
    identity: target.preFileIdentity,
    sha256: target.preSha256,
    bytes: target.preBytes
  }
}

function withExecutionMetadata(
  result: Pick<ToolExecResult, 'ok' | 'output'>,
  execution: LocalCommandResult | undefined,
  sandboxMode: SandboxMode | undefined
): ToolExecResult {
  return {
    ...result,
    sandboxMode: sandboxMode ?? 'restrictedLocal',
    modeUsed: execution?.modeUsed,
    sandboxed: execution?.sandboxed,
    fallbackReason: execution?.fallbackReason
  }
}

async function runBash(
  command: string,
  cwd: string,
  options: ToolExecutionOptions,
  args: Record<string, unknown>
): Promise<ToolExecResult> {
  const sandboxMode = options.sandboxMode ?? 'restrictedLocal'
  let capture: CodeForgeVerificationCapture | undefined, captureError: string | undefined
  if (args.recordVerification === true) {
    try {
      const run = options.sessionId ? taskRuntimeRegistry.get(options.sessionId) : undefined
      if (!run || !options.sessionId || !options.toolUseId || !options.userDataRoot) throw new Error('验证记录缺少当前 Run 身份')
      capture = beginCodeForgeVerification({ rootDir: options.userDataRoot, sessionId: options.sessionId, runId: run.id, toolUseId: options.toolUseId }, cwd, args)
    } catch (error) { captureError = error instanceof Error ? error.message : String(error) }
  }
  const result = await runLocalCommand({
    command,
    cwd,
    mode: sandboxMode,
    timeoutMs: BASH_TIMEOUT_MS,
    maxBufferBytes: 4 * 1024 * 1024,
    chinaMirrorEnabled: options.chinaMirrorEnabled,
    npmRegistry: options.npmRegistry,
    pipIndexUrl: options.pipIndexUrl,
    signal: options.signal
  })
  const execution: ToolExecResult = {
    ok: result.ok,
    output: clip(result.output),
    exitCode: result.exitCode, commandTermination: result.commandTermination,
    sandboxMode,
    modeUsed: result.modeUsed,
    sandboxed: result.sandboxed,
    fallbackReason: result.fallbackReason
  }
  if (capture) {
    try {
      const frozenCapture = capture
      if (!options.sessionMeta) throw new Error('验证记录缺少当前任务身份')
      await withDataLifecycleMutation(capture.rootDir, async () => {
        assertPreparationSessionNotDeleted(frozenCapture.rootDir, options.sessionMeta!)
        if (taskRuntimeRegistry.get(frozenCapture.sessionId)?.id !== frozenCapture.runId) throw new Error('执行期间当前 Run 已变更')
        finishCodeForgeVerification(frozenCapture, execution)
      })
    }
    catch (error) { captureError = error instanceof Error ? error.message : String(error) }
  }
  if (captureError) execution.output += `\n\n验证版本记录未完成：${captureError}；此命令结果不能作为当前代码版本通过的证据。`
  return execution
}
