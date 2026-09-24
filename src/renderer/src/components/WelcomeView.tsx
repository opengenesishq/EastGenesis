import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  LoaderCircle,
  SlidersHorizontal
} from 'lucide-react'
import { modelOptionsForProvider, useStore } from '../store'
import { useT } from '../i18n'
import { matchesDesktopShortcut } from '../desktop-keyboard'
import { AUTO_MODEL } from '../../../shared/types'
import type {
  LocalComputeActivationResult,
  LocalComputeUnavailableReason,
  TaskStrategy
} from '../../../shared/types'
import { useExperienceProjection } from './experience/ExperienceProjection'
import { startWelcomeTask } from './experience/welcome-personal-task'
import PersonalTaskRecoveryPanel from './experience/PersonalTaskRecoveryPanel'
import { PersonalTaskSubmissionError } from '../lib/personal-task-submission'
import AssistantStartNotice from './experience/AssistantStartNotice'
import FirstLaunchProviderOnboarding from './experience/FirstLaunchProviderOnboarding'
import RemoteIntakeReceipts from './experience/RemoteIntakeReceipts'
import { submitWelcomeRemote } from './experience/welcome-remote-task'
import { handoffWelcomeRemoteDraft } from './experience/welcome-remote-draft-handoff'
import { taskWindowSessionId } from '../task-window-context'
import { useAutosizeTextarea } from './useAutosizeTextarea'
import VoiceDraftInput from './VoiceDraftInput'
import {
  assistantSafeStartError,
  hasAvailableCompute,
  welcomeSessionOptions,
  welcomeValidationKey,
  welcomeWorkspaceValidationKey,
  type WelcomeSessionDraft
} from './experience/welcome-session-projection'
import { useWelcomeDraftController } from './experience/useWelcomeDraft'
import {
  patchFirstTaskOnboardingRecord,
  runFirstTaskSubmissionExclusive
} from './experience/first-task-onboarding'
import './welcome-simple.css'

type WelcomeStoreState = ReturnType<typeof useStore.getState>
type WelcomeProjection = ReturnType<typeof useExperienceProjection>

function useLocalComputeActivation(
  projection: WelcomeProjection,
  providersLoaded: boolean,
  computeAvailable: boolean,
  activateLocalCompute: (options?: { startInstalled?: boolean }) => Promise<LocalComputeActivationResult>,
  updateWelcomeDraft: WelcomeStoreState['updateWelcomeDraft'],
  enabled = true
) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'ready' | 'unavailable'>('idle')
  const ensure = useCallback(async (startInstalled = false): Promise<LocalComputeActivationResult> => {
    if (!enabled || useStore.getState().welcomeDraft.executionTarget?.kind === 'remote') return { status: 'unavailable', checkedAt: Date.now(), reason: 'runtime-stopped' }
    if (hasAvailableCompute(useStore.getState().providers)) {
      return { status: 'activated', checkedAt: Date.now() }
    }
    setStatus('checking')
    return activateLocalCompute({ startInstalled })
      .then((result) => {
        if (result.status !== 'activated' || !result.provider) {
          setStatus('unavailable')
          return result
        }
        if (useStore.getState().welcomeDraft.executionTarget?.kind !== 'remote') updateWelcomeDraft({
          computeSelectionSource: 'default',
          providerId: result.provider.id,
          model: AUTO_MODEL
        })
        setStatus('ready')
        return result
      })
      .catch((): LocalComputeActivationResult => {
        setStatus('unavailable')
        return { status: 'unavailable', checkedAt: Date.now(), reason: 'runtime-stopped' }
      })
  }, [activateLocalCompute, updateWelcomeDraft, enabled])

  useEffect(() => {
    if (!enabled || !providersLoaded || projection !== 'assistant' || computeAvailable || status !== 'idle') return
    void ensure(false)
  }, [computeAvailable, ensure, projection, providersLoaded, status, enabled])

  return { localComputeStatus: status, ensureLocalCompute: ensure }
}

type WelcomeRecoveryKind = 'compute' | 'provider' | 'workspace'

function welcomeRecoveryKind(validationKey: string): WelcomeRecoveryKind | null {
  if (validationKey === 'errNeedProjectDir') return 'workspace'
  if (validationKey === 'assistantComputeUnavailable') return 'compute'
  return validationKey === 'explicitProviderRequired' ? 'provider' : null
}

interface WelcomeStartActionsInput {
  projection: WelcomeProjection
  sessionDraft: WelcomeSessionDraft
  text: string
  taskStrategy: TaskStrategy
  computeAvailable: boolean
  ensureLocalCompute: (startInstalled?: boolean) => Promise<LocalComputeActivationResult>
  startSessionWithPrompt: WelcomeStoreState['startSessionWithPrompt']
  refreshProviders: WelcomeStoreState['refreshProviders']
}

interface WelcomeStartFeedback {
  setBusy: (value: boolean) => void
  setComputeReason: (value: LocalComputeUnavailableReason | null) => void
  setError: (value: string) => void
  setRecoveryKind: (value: WelcomeRecoveryKind | null) => void
}

function localComputeValidationKey(reason: LocalComputeUnavailableReason | undefined):
  | 'assistantLocalRuntimeMissing'
  | 'assistantLocalRuntimeStartFailed'
  | 'assistantLocalModelMissing'
  | 'assistantComputeUnavailable' {
  if (reason === 'runtime-missing') return 'assistantLocalRuntimeMissing'
  if (reason === 'runtime-stopped') return 'assistantLocalRuntimeStartFailed'
  if (reason === 'model-missing') return 'assistantLocalModelMissing'
  return 'assistantComputeUnavailable'
}

function safeStartRecoveryKind(
  safeKey: ReturnType<typeof assistantSafeStartError>
): WelcomeRecoveryKind | null {
  if (safeKey === 'assistantWorkspaceUnavailable') return 'workspace'
  return safeKey ? 'compute' : null
}

function useWelcomeSubmitAction(
  input: WelcomeStartActionsInput,
  busy: boolean,
  feedback: WelcomeStartFeedback
) {
  const t = useT()
  return async (
    promptInput = input.text,
    selectedStrategy = input.taskStrategy
  ): Promise<void> => {
    const prompt = promptInput.trim()
    if (!prompt || busy) return
    const selectedDraft = useStore.getState().welcomeDraft
    if (selectedDraft.executionTarget?.kind === 'remote') {
      feedback.setBusy(true); feedback.setError(''); feedback.setRecoveryKind(null); feedback.setComputeReason(null)
      try {
        if (taskWindowSessionId()) {
          await handoffWelcomeRemoteDraft(selectedDraft, prompt)
          feedback.setError(useStore.getState().settings.language === 'zh' ? '草稿已交给主工作台，请在主窗口确认后发送。' : 'Draft passed to the main workspace. Confirm and send it there.')
        } else await submitWelcomeRemote(selectedDraft, prompt)
      } catch (cause) { feedback.setError(cause instanceof Error ? cause.message : 'Remote submission unconfirmed') }
      finally { feedback.setBusy(false) }
      return
    }
    await runFirstTaskSubmissionExclusive(async () => {
      feedback.setBusy(true)
      const draft = { ...input.sessionDraft, taskStrategy: selectedStrategy }
      // A work folder is optional context; the first screen always stays in
      // the single assistant conversation path.
      const effectiveProjection: WelcomeProjection = 'assistant'
      try {
        const workspaceValidationKey = welcomeWorkspaceValidationKey(draft)
        if (workspaceValidationKey) {
          feedback.setError(t(workspaceValidationKey))
          feedback.setRecoveryKind('workspace')
          feedback.setComputeReason(null)
          return
        }
        let available = input.computeAvailable
        let localResult: LocalComputeActivationResult | undefined
        if (effectiveProjection === 'assistant' && !available) {
          localResult = await input.ensureLocalCompute(true)
          available = localResult.status === 'activated'
        }
        const validationKey = welcomeValidationKey(effectiveProjection, draft, available)
        if (validationKey) {
          feedback.setError(t(localResult ? localComputeValidationKey(localResult.reason) : validationKey))
          feedback.setRecoveryKind(welcomeRecoveryKind(validationKey))
          feedback.setComputeReason(localResult?.reason ?? null)
          return
        }
        feedback.setError('')
        feedback.setRecoveryKind(null)
        feedback.setComputeReason(null)
        const savedDraft = JSON.stringify(useStore.getState().welcomeDraft)
        const options = welcomeSessionOptions(effectiveProjection, draft, prompt)
        const candidateSessionId = await input.startSessionWithPrompt(options, prompt)
        patchFirstTaskOnboardingRecord({
          candidateSessionId,
          // The first screen no longer has preset workflows; every request
          // follows the same direct task path.
          presetKey: 'custom',
          startedAt: Date.now()
        })
        if (JSON.stringify(useStore.getState().welcomeDraft) === savedDraft) useStore.getState().clearWelcomeDraft()
      } catch (err) {
        const safeKey = err instanceof PersonalTaskSubmissionError ? null : assistantSafeStartError(input.projection, err)
        feedback.setError(safeKey ? t(safeKey) : err instanceof Error ? err.message : String(err))
        feedback.setRecoveryKind(safeStartRecoveryKind(safeKey))
        feedback.setComputeReason(null)
      } finally {
        feedback.setBusy(false)
      }
    })
  }
}

function useWelcomeRetryAction(
  input: WelcomeStartActionsInput,
  recoveryKind: WelcomeRecoveryKind | null,
  feedback: WelcomeStartFeedback
) {
  const t = useT()
  const retryLocalCompute = async (): Promise<void> => {
    const result = await input.ensureLocalCompute(true)
    if (result.status !== 'activated') await input.refreshProviders()
    const available = hasAvailableCompute(useStore.getState().providers)
    feedback.setError(available ? '' : t(localComputeValidationKey(result.reason)))
    feedback.setRecoveryKind(available ? null : 'compute')
    feedback.setComputeReason(available ? null : result.reason ?? null)
  }

  const retryProviderCompute = async (): Promise<void> => {
    await input.refreshProviders()
    const available = hasAvailableCompute(useStore.getState().providers)
    feedback.setError(available ? '' : t('explicitProviderRequired'))
    feedback.setRecoveryKind(available ? null : 'provider')
    feedback.setComputeReason(null)
  }

  return async (): Promise<void> => {
    const nextRecovery = recoveryKind ?? (input.projection === 'assistant' ? 'compute' : 'provider')
    feedback.setBusy(true)
    try {
      if (nextRecovery === 'compute') await retryLocalCompute()
      else await retryProviderCompute()
    } catch {
      feedback.setError(t(
        nextRecovery === 'provider' ? 'welcomeProviderRefreshFailed' : 'assistantComputeCheckFailed'
      ))
      feedback.setRecoveryKind(nextRecovery)
      feedback.setComputeReason(null)
    } finally {
      feedback.setBusy(false)
    }
  }
}

function useWelcomeStartActions(input: WelcomeStartActionsInput) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKind, setRecoveryKind] = useState<WelcomeRecoveryKind | null>(null)
  const [computeReason, setComputeReason] = useState<LocalComputeUnavailableReason | null>(null)
  const feedback = { setBusy, setComputeReason, setError, setRecoveryKind }
  const submit = useWelcomeSubmitAction(input, busy, feedback)
  const retryCompute = useWelcomeRetryAction(input, recoveryKind, feedback)

  const clearError = (): void => {
    setError('')
    setRecoveryKind(null)
    setComputeReason(null)
  }

  return {
    busy,
    clearError,
    computeReason,
    error,
    recoveryKind,
    retryCompute,
    submit
  }
}

type WelcomeDraftController = ReturnType<typeof useWelcomeDraftController>
type WelcomeModelOptions = ReturnType<typeof modelOptionsForProvider>
type WelcomeStartActions = ReturnType<typeof useWelcomeStartActions>

function buildWelcomeSessionDraft(
  welcome: WelcomeDraftController,
  welcomeDraft: WelcomeStoreState['welcomeDraft'],
  taskStrategy: TaskStrategy
): WelcomeSessionDraft {
  return {
    cwd: welcome.cwd,
    driveMode: welcome.driveMode,
    model: welcome.model,
    taskStrategy,
    projectId: undefined,
    providerId: welcome.providerId,
    routingMode: welcome.routingMode,
    unassigned: true,
    forkFromSdkSessionId: welcomeDraft.forkFromSdkSessionId,
    forkCheckpointId: welcomeDraft.forkCheckpointId
  }
}

function useWelcomeModelOptions(
  welcome: WelcomeDraftController,
  providers: WelcomeStoreState['providers']
): { fixedModelOptions: WelcomeModelOptions } {
  const t = useT()
  const modelOptions = useMemo(() => modelOptionsForProvider(
    providers,
    welcome.providerId,
    t('autoRoute'),
    welcome.model
  ), [providers, t, welcome.model, welcome.providerId])
  return {
    fixedModelOptions: modelOptions.filter((option) => option.value !== AUTO_MODEL)
  }
}

function WelcomeComposerBar({
  actions,
  computeAvailable,
  fixedModelOptions,
  localComputeStatus,
  onOpenSettings,
  providers,
  welcome,
  welcomeDraft
}: {
  actions: WelcomeStartActions
  computeAvailable: boolean
  fixedModelOptions: WelcomeModelOptions
  localComputeStatus: ReturnType<typeof useLocalComputeActivation>['localComputeStatus']
  onOpenSettings: () => void
  providers: WelcomeStoreState['providers']
  welcome: WelcomeDraftController
  welcomeDraft: WelcomeStoreState['welcomeDraft']
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const voiceDraftId = useRef(`draft:${crypto.randomUUID()}`)
  const remote = welcomeDraft.executionTarget?.kind === 'remote'
  const awaitingModel = !remote && !computeAvailable && localComputeStatus !== 'ready'
  const selectedModel = fixedModelOptions.some(option => option.value === welcome.model) ? welcome.model : ''
  return (
    <div className="welcome-composer-bar">
      <div className="welcome-model-picker" data-welcome-model-picker>
        {remote ? <span className="welcome-remote-note">{zh ? '远端模型' : 'Remote model'}</span> : <>
          {providers.length > 1 && <select
            className="welcome-model-select welcome-provider-select"
            data-welcome-routing-control="provider"
            aria-label={zh ? '选择模型厂商' : 'Choose provider'}
            value={welcome.providerId}
            onChange={(event) => welcome.setProvider(event.target.value)}
          >
            <option value="" disabled>{zh ? '选择厂商' : 'Choose provider'}</option>
            {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.ready}>{provider.name}{provider.ready ? '' : ` · ${zh ? '未配置' : 'not configured'}`}</option>)}
          </select>}
          <select
            className="welcome-model-select"
            data-welcome-routing-control="model"
            aria-label={zh ? '选择模型' : 'Choose model'}
            value={selectedModel}
            disabled={!fixedModelOptions.length}
            onChange={(event) => welcome.update({ computeSelectionSource: 'user', routingMode: 'fixed', model: event.target.value })}
          >
            <option value="" disabled>{fixedModelOptions.length ? (zh ? '选择模型' : 'Choose a model') : (zh ? '先连接模型' : 'Connect a model first')}</option>
            {fixedModelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </>}
      </div>
      {!remote && <button type="button" className="welcome-advanced-trigger" aria-label={zh ? '打开模型设置' : 'Open model settings'} title={zh ? '模型与连接设置' : 'Model and connection settings'} onClick={onOpenSettings}><SlidersHorizontal size={15} aria-hidden="true" /></button>}
      {!remote && <VoiceDraftInput contextId={voiceDraftId.current} disabled={actions.busy}
        onOpenSettings={() => useStore.getState().setShowSettings(true, 'voice')}
        onInsert={transcript => {
          const current = useStore.getState().welcomeDraft.text
          welcome.update({ text: current ? `${current}\n${transcript}` : transcript })
        }} />}
      <button
        type="button"
        className={`welcome-send${awaitingModel ? ' welcome-send-connect' : ''}`}
        aria-label={awaitingModel ? (zh ? '连接模型' : 'Connect a model') : remote && taskWindowSessionId() ? (zh ? '交给主工作台' : 'Pass to main workspace') : (zh ? '发送并执行' : 'Send and run')}
        title={awaitingModel ? (zh ? '连接模型后继续当前任务' : 'Connect a model to continue') : (zh ? '发送并执行' : 'Send and run')}
        disabled={actions.busy || (!awaitingModel && !welcome.text.trim()) || (!computeAvailable && localComputeStatus === 'checking')}
        onClick={() => {
          if (awaitingModel) onOpenSettings()
          else void actions.submit(undefined, 'execute')
        }}
      >
        {awaitingModel
          ? <span>{zh ? '连接模型' : 'Connect model'}</span>
          : actions.busy
            ? <LoaderCircle className="welcome-send-spinner" size={17} aria-hidden="true" />
            : <ArrowUp size={17} strokeWidth={2.2} aria-hidden="true" />}
      </button>
    </div>
  )
}

function WelcomeComposer({
  actions,
  computeAvailable,
  fixedModelOptions,
  localComputeStatus,
  onBrowse,
  onKeyDown,
  onOpenSettings,
  providers,
  textareaRef,
  welcome,
  welcomeDraft
}: {
  actions: WelcomeStartActions
  computeAvailable: boolean
  fixedModelOptions: WelcomeModelOptions
  localComputeStatus: ReturnType<typeof useLocalComputeActivation>['localComputeStatus']
  onBrowse: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onOpenSettings: () => void
  providers: WelcomeStoreState['providers']
  textareaRef: React.RefObject<HTMLTextAreaElement>
  welcome: WelcomeDraftController
  welcomeDraft: WelcomeStoreState['welcomeDraft']
}): React.JSX.Element {
  const t = useT()
  const zh = useStore(state => state.settings.language === 'zh')
  const remote = welcomeDraft.executionTarget?.kind === 'remote'
  const [attachmentNotice, setAttachmentNotice] = useState('')
  useAutosizeTextarea(textareaRef, welcome.text)
  return (
    <div className="welcome-compose-dock">
      <div className="welcome-composer">
        {welcomeDraft.forkFromSdkSessionId ? <div className="welcome-fork-source">{t('conversationForkSource', { title: welcomeDraft.forkSourceTitle ?? t('conversation') })}</div> : null}
        <textarea
          ref={textareaRef}
          className="welcome-composer-input"
          placeholder={zh ? '告诉 EastGenesis 你要完成什么，按 Enter 直接开始…' : 'Tell EastGenesis what to do, then press Enter to start…'}
          value={welcome.text}
          rows={1}
          onChange={(event) => welcome.update({ text: event.target.value })}
          onKeyDown={onKeyDown}
          onPaste={event => { if (remote && event.clipboardData.files.length) { event.preventDefault(); setAttachmentNotice(zh ? '远端任务暂不支持粘贴文件，正文已保留。' : 'Remote tasks do not accept pasted files; your text is preserved.') } }}
          onDragOver={event => { if (remote && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
          onDrop={event => { if (remote && event.dataTransfer.files.length) { event.preventDefault(); setAttachmentNotice(zh ? '远端任务暂不支持本机文件，正文已保留。' : 'Remote tasks do not accept local files; your text is preserved.') } }}
          data-composer-autosize="true"
          autoFocus
        />
        <WelcomeComposerBar
          actions={actions}
          computeAvailable={computeAvailable}
          fixedModelOptions={fixedModelOptions}
          localComputeStatus={localComputeStatus}
          onOpenSettings={onOpenSettings}
          providers={providers}
          welcome={welcome}
          welcomeDraft={welcomeDraft}
        />
      </div>
      {attachmentNotice && <p role="alert" className="welcome-remote-note">{attachmentNotice}<button type="button" onClick={() => setAttachmentNotice('')}>{zh ? '知道了' : 'Dismiss'}</button></p>}
      <RemoteIntakeReceipts refreshKey={actions.busy} />
      {!remote && <PersonalTaskRecoveryPanel refreshKey={actions.busy} />}
      <AssistantStartNotice
        busy={actions.busy}
        computeReason={actions.computeReason}
        error={actions.error}
        recoveryKind={actions.recoveryKind}
        onChooseWorkspace={onBrowse}
        onOpenSettings={onOpenSettings}
        onRetry={() => void actions.retryCompute()}
      />
    </div>
  )
}

/** 首屏打开即输入，任务策略决定后端派生的权限模式。 */
export default function WelcomeView(): React.JSX.Element {
  const t = useT()
  const projection = useExperienceProjection()
  const settings = useStore((state) => state.settings)
  const providers = useStore((state) => state.providers)
  const providersLoaded = useStore((state) => state.providersLoaded)
  const projects = useStore((state) => state.projects)
  const welcomeDraft = useStore((state) => state.welcomeDraft)
  const requestedProjectId = useStore((state) => state.newSessionProjectId)
  const startSessionWithPrompt = startWelcomeTask
  const refreshProviders = useStore((state) => state.refreshProviders)
  const activateLocalCompute = useStore((state) => state.activateLocalCompute)
  const setShowSettings = useStore((state) => state.setShowSettings)
  const welcome = useWelcomeDraftController({
    projects,
    providers,
    requestedProjectId,
    settings,
    preferInitialProject: projection !== 'assistant'
  })
  const { text } = welcome
  // The first screen is intentionally a direct-execution surface. Advanced
  // planning remains available inside an active task, but never blocks the
  // first sentence a user sends from here.
  const taskStrategy: TaskStrategy = 'execute'
  const taRef = useRef<HTMLTextAreaElement>(null)
  const computeAvailable = hasAvailableCompute(providers)
  const { localComputeStatus, ensureLocalCompute } = useLocalComputeActivation(
    projection,
    providersLoaded,
    computeAvailable,
    activateLocalCompute,
    welcome.update,
    welcomeDraft.executionTarget?.kind !== 'remote'
  )
  const sessionDraft = buildWelcomeSessionDraft(
    welcome,
    welcomeDraft,
    taskStrategy
  )
  const actions = useWelcomeStartActions({
    projection,
    sessionDraft,
    text,
    taskStrategy,
    computeAvailable,
    ensureLocalCompute,
    startSessionWithPrompt,
    refreshProviders
  })
  const { fixedModelOptions } = useWelcomeModelOptions(welcome, providers)

  const browse = async (): Promise<void> => {
    const dir = await window.agentDesk.pickDirectory()
    if (!dir) return
    welcome.setPickedDirectory(dir)
    actions.clearError()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!matchesDesktopShortcut(event.nativeEvent, 'sendMessage', settings.desktopShortcuts)) return
    event.preventDefault()
    void actions.submit()
  }

  return (
    <div className="welcome welcome-hero welcome-simple-shell">
      <FirstLaunchProviderOnboarding />
      <div className="welcome-stage">
        <div className="welcome-hero-inner">
          <h1 className="welcome-ask" data-welcome-heading="true">{t('welcomeAsk')}</h1>
        <WelcomeComposer
          actions={actions}
          computeAvailable={computeAvailable}
          fixedModelOptions={fixedModelOptions}
          localComputeStatus={localComputeStatus}
          onBrowse={() => void browse()}
          onKeyDown={onKeyDown}
          onOpenSettings={() => setShowSettings(true, 'providers', 'welcome-provider-recovery')}
          providers={providers}
          textareaRef={taRef}
          welcome={welcome}
          welcomeDraft={welcomeDraft}
        />
        </div>
      </div>
    </div>
  )
}
