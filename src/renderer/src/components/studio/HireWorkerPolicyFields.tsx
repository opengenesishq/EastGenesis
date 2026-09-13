import type { Dispatch, SetStateAction } from 'react'
import { studioLocalized } from './digital-worker-studio-model'

interface HireWorkerPolicyFieldsProps {
  monthlyBudget: string
  concurrency: string
  minimumEvidenceCount: string
  requireUserApproval: boolean
  escalationTarget: string
  escalateAfterFailures: string
  setMonthlyBudget: Dispatch<SetStateAction<string>>
  setConcurrency: Dispatch<SetStateAction<string>>
  setMinimumEvidenceCount: Dispatch<SetStateAction<string>>
  setRequireUserApproval: Dispatch<SetStateAction<boolean>>
  setEscalationTarget: Dispatch<SetStateAction<string>>
  setEscalateAfterFailures: Dispatch<SetStateAction<string>>
}

export default function HireWorkerPolicyFields(props: HireWorkerPolicyFieldsProps): React.JSX.Element {
  const {
    monthlyBudget,
    concurrency,
    minimumEvidenceCount,
    requireUserApproval,
    escalationTarget,
    escalateAfterFailures,
    setMonthlyBudget,
    setConcurrency,
    setMinimumEvidenceCount,
    setRequireUserApproval,
    setEscalationTarget,
    setEscalateAfterFailures
  } = props

  return (
    <>
      <label className="dws-field">
        <span>{studioLocalized('月度预算 (USD)', 'Monthly budget (USD)')}</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={monthlyBudget}
          onChange={(event) => setMonthlyBudget(event.target.value)}
          placeholder={studioLocalized('不设限', 'Unlimited')}
        />
      </label>
      <label className="dws-field">
        <span>{studioLocalized('最大并发', 'Maximum concurrency')}</span>
        <input
          type="number"
          min="1"
          max="32"
          step="1"
          value={concurrency}
          onChange={(event) => setConcurrency(event.target.value)}
          required
        />
      </label>
      <label className="dws-field">
        <span>{studioLocalized('最少 Evidence 数', 'Minimum Evidence count')}</span>
        <input
          type="number"
          min="0"
          max="10000"
          step="1"
          value={minimumEvidenceCount}
          onChange={(event) => setMinimumEvidenceCount(event.target.value)}
          required
        />
      </label>
      <label className="dws-check">
        <input
          type="checkbox"
          checked={requireUserApproval}
          onChange={(event) => setRequireUserApproval(event.target.checked)}
        />
        <span>{studioLocalized('验收需用户确认', 'Require user confirmation for acceptance')}</span>
      </label>
      <label className="dws-field">
        <span>{studioLocalized('升级目标', 'Escalation target')}</span>
        <input
          value={escalationTarget}
          onChange={(event) => setEscalationTarget(event.target.value)}
          required
          maxLength={120}
        />
      </label>
      <label className="dws-field">
        <span>{studioLocalized('连续失败后升级', 'Escalate after consecutive failures')}</span>
        <input
          type="number"
          min="1"
          max="10000"
          step="1"
          value={escalateAfterFailures}
          onChange={(event) => setEscalateAfterFailures(event.target.value)}
          required
        />
      </label>
    </>
  )
}
