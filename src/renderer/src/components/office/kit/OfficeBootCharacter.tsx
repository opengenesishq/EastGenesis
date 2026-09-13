import LowPolyDigitalWorkerRig from './LowPolyDigitalWorkerRig'

interface OfficeBootCharacterProps {
  sessionId: string
  active: boolean
}

export default function OfficeBootCharacter({ sessionId, active }: OfficeBootCharacterProps): React.JSX.Element {
  const accent = active ? '#59dcff' : '#697680'
  return (
    <group
      name="office-boot-articulated-worker"
      position={[0, 0, 0.28]}
      userData={{
        officeCharacterRenderer: 'articulated-3d',
        officeCharacterGrounded: true,
        officeRobotLoading: true,
        officeRobotSessionId: sessionId
      }}
    >
      <LowPolyDigitalWorkerRig
        sessionId={sessionId}
        role="operations"
        detailLevel="low"
        accentColor={accent}
        scale={0.82}
      />
    </group>
  )
}
