import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputerHistorySource } from '../../shared/computer-history-types'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'
import { isBrowserBundleId, isBundleId, isRecord } from './policy'

export type HistoryCaptureResult = { status: 'permission-required' | 'skipped' } | { status: 'captured'; bundleId: string; title: string }
export interface HistoryCollector {
  sources(signal: AbortSignal): Promise<ComputerHistorySource[]>
  capture(allowedBundleIds: string[], signal: AbortSignal): Promise<HistoryCaptureResult>
  dispose?(): void
}

/** The only AX read is reached AFTER the native foreground bundle allowlist guard.
 * No all-window enumeration, screenshots, children, value fields, or browser content. */
export const MACOS_HISTORY_HELPER_SOURCE = String.raw`
import AppKit
import ApplicationServices
import Foundation

func output(_ value: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
  }
}
func excluded(_ app: NSRunningApplication) -> String? {
  let id = (app.bundleIdentifier ?? "").lowercased()
  if id.hasPrefix("com.caogen.") || id.hasPrefix("com.electron.") { return "caogen" }
  let known = ["safari", "chrome", "chromium", "firefox", "brave", "vivaldi", "opera", "microsoft.edgemac", "duckduckgo", "thebrowser.browser", "browsercompany", "zen-browser", "waterfox", "librewolf", "orion"]
  if known.contains(where: { id.contains($0) }) { return "browser" }
  if let url = app.bundleURL, let bundle = Bundle(url: url), let types = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] {
    for entry in types {
      if let schemes = entry["CFBundleURLSchemes"] as? [String], schemes.contains(where: { ["http", "https"].contains($0.lowercased()) }) { return "browser" }
    }
  }
  return nil
}
let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if mode == "sources" {
  var rows: [[String: String]] = []
  var seen = Set<String>()
  for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
    guard let id = app.bundleIdentifier, !seen.contains(id) else { continue }
    seen.insert(id)
    var row = ["bundleId": id, "name": String((app.localizedName ?? id).prefix(160))]
    if let reason = excluded(app) { row["excludedReason"] = reason }
    rows.append(row)
  }
  output(rows)
} else if mode == "capture" {
  let input = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "[]"
  let allowed = Set((try? JSONSerialization.jsonObject(with: Data(input.utf8))) as? [String] ?? [])
  // Identity metadata is needed to decide authority; no window is inspected yet.
  guard let app = NSWorkspace.shared.frontmostApplication, let id = app.bundleIdentifier,
        allowed.contains(id), excluded(app) == nil, !app.isTerminated else {
    output(["status": "skipped"]); exit(0)
  }
  guard AXIsProcessTrusted() else { output(["status": "permission-required"]); exit(0) }
  let element = AXUIElementCreateApplication(app.processIdentifier)
  var focused: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success,
        let value = focused, CFGetTypeID(value) == AXUIElementGetTypeID() else { output(["status": "skipped"]); exit(0) }
  let window = unsafeBitCast(value, to: AXUIElement.self)
  var titleValue: CFTypeRef?
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
        AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleValue) == .success,
        let title = titleValue as? String, !title.isEmpty,
        NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { output(["status": "skipped"]); exit(0) }
  output(["status": "captured", "bundleId": id, "title": String(title.prefix(600))])
} else { output(["status": "skipped"]) }
`

/** Lazily compiles an app-owned helper; its commands only run after explicit configuration. */
export class MacosComputerHistoryCollector implements HistoryCollector {
  private directory?: string
  private executable?: Promise<string>
  private compiler?: AbortController
  private disposed = false
  async sources(signal: AbortSignal): Promise<ComputerHistorySource[]> {
    const raw: unknown = await this.command(['sources'], signal)
    if (!Array.isArray(raw)) throw new Error('无法读取应用来源列表。')
    return raw.filter(item => isRecord(item) && isBundleId(item.bundleId) && typeof item.name === 'string').map(item => ({
      bundleId: item.bundleId as string, name: (item.name as string).slice(0, 160),
      ...(item.excludedReason === 'browser' || item.excludedReason === 'caogen' ? { excludedReason: item.excludedReason } :
        isBrowserBundleId(item.bundleId as string) ? { excludedReason: 'browser' as const } : {})
    })).slice(0, 300)
  }
  async capture(allowedBundleIds: string[], signal: AbortSignal): Promise<HistoryCaptureResult> {
    if (allowedBundleIds.length === 0) return { status: 'skipped' }
    const raw: unknown = await this.command(['capture', JSON.stringify(allowedBundleIds)], signal)
    if (!isRecord(raw) || !['captured', 'skipped', 'permission-required'].includes(String(raw.status))) throw new Error('前台应用记录结果无效。')
    if (raw.status !== 'captured') return { status: raw.status as 'skipped' | 'permission-required' }
    if (!isBundleId(raw.bundleId) || !allowedBundleIds.includes(raw.bundleId) || typeof raw.title !== 'string') throw new Error('前台应用不在允许来源中。')
    return { status: 'captured', bundleId: raw.bundleId, title: raw.title.slice(0, 600) }
  }
  dispose(): void { this.disposed = true; this.compiler?.abort(); if (this.directory) rmSync(this.directory, { recursive: true, force: true }) }
  private async command(args: string[], signal: AbortSignal): Promise<unknown> {
    if (process.platform !== 'darwin' || this.disposed || signal.aborted) throw new Error('电脑历史采集当前不可用。')
    const executable = await this.ensureExecutable()
    if (signal.aborted || this.disposed) throw new Error('采集已停止。')
    const output = await runHelper(executable, args, signal, 5_000)
    if (signal.aborted || this.disposed) throw new Error('采集已停止。')
    try { return JSON.parse(output) } catch { throw new Error('无法解析电脑历史采集结果。') }
  }
  private ensureExecutable(): Promise<string> {
    if (this.executable) return this.executable
    this.directory = mkdtempSync(join(tmpdir(), 'caogen-history-helper-'))
    const source = join(this.directory, 'history.swift'), executable = join(this.directory, 'history-helper')
    writeFileSync(source, MACOS_HISTORY_HELPER_SOURCE, { mode: 0o600 })
    this.compiler = new AbortController()
    this.executable = runHelper('/usr/bin/swiftc', [source, '-o', executable], this.compiler.signal, 45_000).then(() => executable).catch(() => {
      this.executable = undefined
      if (this.directory) rmSync(this.directory, { recursive: true, force: true })
      this.directory = undefined
      throw new Error('电脑历史辅助程序不可用。需要 macOS 和 Apple 命令行开发工具。')
    })
    return this.executable
  }
}
function runHelper(file: string, args: string[], signal: AbortSignal, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { signal, timeout, maxBuffer: 256 * 1024, env: buildMinimalSubprocessEnv(), windowsHide: true },
    (error, stdout) => { if (error) reject(new Error('电脑历史辅助程序未完成；请检查系统权限与开发工具。')); else resolve(stdout) }))
}
