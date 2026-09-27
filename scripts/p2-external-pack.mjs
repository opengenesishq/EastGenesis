#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const packDir = path.join(repoRoot, 'test-results', 'p2-external-pack', runId)
const latestPath = path.join(repoRoot, 'test-results', 'p2-external-pack', 'latest.json')

mkdirSync(packDir, { recursive: true })

const files = [
  writePackFile('README.md', readmeText()),
  writePackFile('.env.template', envTemplate()),
  writePackFile('china-parity-providers.template.json', JSON.stringify(chinaProviderTemplate(), null, 2)),
  writePackFile('jetbrains-evidence.template.json', JSON.stringify(jetbrainsEvidenceTemplate(), null, 2)),
  writePackFile('run-required-gates.ps1', powershellRunner())
]

const report = {
  status: 'generated',
  packDir,
  files,
  commands: {
    doctor: 'npm.cmd run test:p2-external:doctor -- --refresh',
    preflight: 'npm.cmd run test:p2-external:preflight -- --required',
    chinaRealNetwork: 'npm.cmd run test:china-real-network:required',
    chinaToolCallParity: 'npm.cmd run test:china-tool-call-parity:required',
    jetbrainsIdeInteraction: 'npm.cmd run test:jetbrains-ide-interaction:required',
    aggregate: 'npm.cmd run test:p2-required'
  },
  notes: [
    'Templates intentionally contain placeholders only.',
    'Do not commit filled templates that contain secrets or private endpoints.',
    'Run preflight before the required gates in a machine that has real credentials and a real JetBrains IDE.'
  ]
}

writeFileSync(path.join(packDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))

function writePackFile(name, content) {
  const filePath = path.join(packDir, name)
  writeFileSync(filePath, `${content.trimEnd()}\n`, 'utf8')
  return {
    name,
    path: path.relative(repoRoot, filePath)
  }
}

function readmeText() {
  return `# P2 External Required Evidence Pack

This pack is generated from the current EastGenesis checkout. It contains templates only.

## Steps

1. Copy \`.env.template\` to a private local file outside git tracking.
2. Fill real webhook URLs, integration API tokens, and JetBrains IDE paths in the private env file.
3. Fill \`china-parity-providers.template.json\`, then save the private copy as \`~/.caogen-private/provider-parity.json\`.
4. Run the JetBrains plugin in a real IDE and fill \`jetbrains-evidence.template.json\` with observed evidence and artifact paths.
5. Run \`run-required-gates.ps1 -EnvFile D:\\private\\p2.external.env\` from the repository root.

## Expected closeout

P2 can only be marked complete when these commands pass with real external evidence:

- \`npm.cmd run test:china-real-network:required\`
- \`npm.cmd run test:china-tool-call-parity:required\`
- \`npm.cmd run test:jetbrains-ide-interaction:required\`
- \`npm.cmd run test:p2-required\`
`
}

function envTemplate() {
  return `# P2 external required verification environment.
# Fill placeholders in a private copy. Do not commit filled secrets.

CAOGEN_CHINA_REAL_NETWORK=1
# Required in required mode: comma-separated real-network targets to close out.
# Example: feishu,dingtalk,gitee_issue
CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS=
FEISHU_WEBHOOK_URL=
FEISHU_WEBHOOK_SECRET=
DINGTALK_WEBHOOK_URL=
DINGTALK_WEBHOOK_SECRET=
GITEE_ACCESS_TOKEN=
GITEE_OWNER=
GITEE_REPO=
GITEE_PR_HEAD=
GITEE_PR_BASE=
GITEE_API_URL=
ALIYUN_YUNXIAO_API_URL=
ALIYUN_YUNXIAO_TOKEN=
ALIYUN_YUNXIAO_METHOD=
ALIYUN_YUNXIAO_BODY=
ALIYUN_YUNXIAO_AUTH_PREFIX=

CAOGEN_CHINA_TOOL_CALL_PARITY=1
CAOGEN_CHINA_PARITY_REQUIRE_BASELINE=1
CAOGEN_CHINA_PARITY_MAX_GAP=0

CAOGEN_JETBRAINS_IDE_PATH=
CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON=
# Optional alternative to hand-filled evidence JSON: use the opt-in JetBrains recorder JSONL.
CAOGEN_JETBRAINS_IDE_RECORDER_JSONL=
CAOGEN_JETBRAINS_NATIVE_UNDO_VERIFIED=
`
}

function chinaProviderTemplate() {
  return [
    {
      id: 'openai-baseline',
      name: 'OpenAI baseline',
      group: 'baseline',
      apiFormat: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      model: '<baseline-model>',
      apiKey: '<secret>'
    },
    {
      id: 'deepseek-china',
      name: 'DeepSeek China',
      group: 'china',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '<secret>'
    },
    {
      id: 'qwen-china',
      name: 'Qwen China',
      group: 'china',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKey: '<secret>'
    }
  ]
}

function jetbrainsEvidenceTemplate() {
  return {
    ideName: 'IntelliJ IDEA',
    ideVersion: '<real IDE version>',
    ideExecutable: '<absolute path to idea64.exe or webstorm64.exe>',
    pluginVersion: '0.0.1',
    workspace: repoRoot,
    pluginDistribution: pluginDistributionPath(),
    steps: {
      installedPlugin: true,
      connectCreateSession: true,
      sendChatMessage: true,
      sendSelection: true,
      requestSelectionEdit: true,
      previewSelectionDiff: true,
      applySelectionEdit: true,
      nativeUndoVerified: true,
      toggleRealtimeSync: true,
      documentSyncObserved: true,
      showEvents: true,
      openDesktop: true
    },
    bridgeEvents: {
      helloCount: 1,
      sessionCreateCount: 1,
      sessionSendCount: 3,
      chatSendCount: 1,
      selectionSendCount: 1,
      editRequestSendCount: 1,
      documentSyncCount: 1
    },
    actionCounts: {
      diffPreviewCount: 1,
      applyEditCount: 1,
      nativeUndoCount: 1,
      realtimeToggleCount: 1,
      openDesktopCount: 1
    },
    artifacts: [
      '<absolute path to IDE log, screenshot, or recording>'
    ]
  }
}

function powershellRunner() {
  return `param(
  [string]$EnvFile = ""
)

$ErrorActionPreference = "Stop"

function Import-P2EnvFile {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }
  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  Write-Host "Loading P2 external env file: $($resolved.Path)"
  foreach ($rawLine in Get-Content -LiteralPath $resolved.Path) {
    $line = ([string]$rawLine).Trim().Trim([char]0xFEFF)
    if ($line.Length -eq 0 -or $line.StartsWith("#")) {
      continue
    }
    $index = $line.IndexOf("=")
    if ($index -lt 1) {
      throw "Invalid env line in $($resolved.Path): $line"
    }
    $name = $line.Substring(0, $index).Trim()
    if ($name -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
      throw "Invalid env name in $($resolved.Path): $name"
    }
    $value = $line.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Assert-NoPlaceholderEnv {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($value -match "^<[^>]+>$") {
      throw "$name still contains a placeholder value"
    }
  }
}

Import-P2EnvFile -Path $EnvFile
Assert-NoPlaceholderEnv -Names @(
  "CAOGEN_JETBRAINS_IDE_PATH",
  "CAOGEN_JETBRAINS_IDE_EVIDENCE_JSON",
  "CAOGEN_JETBRAINS_IDE_RECORDER_JSONL"
)

Write-Host "P2 external doctor"
npm.cmd run test:p2-external:doctor -- --refresh

Write-Host "P2 external preflight"
npm.cmd run test:p2-external:preflight -- --required

Write-Host "China real network"
npm.cmd run test:china-real-network:required

Write-Host "China tool-call parity"
npm.cmd run test:china-tool-call-parity:required

Write-Host "JetBrains real IDE interaction"
npm.cmd run test:jetbrains-ide-interaction:required

Write-Host "Aggregate P2 required gate"
npm.cmd run test:p2-required
`
}

function pluginDistributionPath() {
  const relative = path.join('plugins', 'jetbrains', 'build', 'distributions', 'caogen-jetbrains-bridge-0.0.1.zip')
  const absolute = path.join(repoRoot, relative)
  return existsSync(absolute) ? absolute : relative
}
