import { AnthropicEngine } from './anthropicEngine'
import { buildGoogleGenerateContentRequest, streamGoogleGenAiMessage } from './googleGenAiAdapter'
import { applyGoogleRuntimeToRequest } from './googleGenAiRequest'
import { resolveGoogleGenAiTarget } from './provider/googleGenAiTarget'
import { AnthropicModelAttemptTracker } from './task/anthropic-model-attempt-runtime'
import type { EngineEmit } from './engine'
import type { SessionMeta } from '../shared/types'

export class GoogleGenAiRuntime extends AnthropicEngine {
  constructor(
    meta: SessionMeta,
    emit: EngineEmit,
    resumeSdkSessionId?: string,
    initialEventSeq = 0
  ) {
    super(meta, emit, resumeSdkSessionId, initialEventSeq, {
      resolveTarget: resolveGoogleGenAiTarget,
      streamMessage: streamGoogleGenAiMessage,
      modelAttempts: new AnthropicModelAttemptTracker(undefined, {
        protocol: 'google.generative-language',
        adapterVersion: 'google-generative-language-v1beta',
        executorComponent: 'google_genai_runtime',
        label: 'Google Generative Language'
      }),
      sessionIdPrefix: 'gemini',
      recoveryEngineKind: 'gemini',
      requiresThinkingSignature: () => true,
      applyRuntimeToRequest: applyGoogleRuntimeToRequest,
      buildWireBody: buildGoogleGenerateContentRequest
    })
  }
}
