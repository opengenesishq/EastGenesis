import MingCharacterRig from './kit/ming-characters/MingCharacterRig'
import { PALACE_WORLD_LAYOUT } from './kit/palace/palaceWorldLayout'

export default function OfficeBootScene({
  ids,
  positions,
  activeId: _activeId,
  lightMode,
  showCharacters,
  interactive,
  onSelect,
  onOpen
}: {
  ids: string[]
  positions: Array<[number, number, number]>
  activeId: string | null
  lightMode: boolean
  showCharacters: boolean
  interactive: boolean
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}): React.JSX.Element {
  return (
    <group name="office-boot-scene" userData={{ officeBootScene: true }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={PALACE_WORLD_LAYOUT.groundSize} />
        <meshBasicMaterial color={lightMode ? '#e1dccb' : '#455149'} />
      </mesh>
      {ids.map((id, index) => {
        const position = positions[index]
        return (
          <group
            key={id}
            name="office-boot-workstation"
            position={position}
            userData={{ officeBootWorkstation: true, officeRobotSessionId: id }}
            {...(interactive
              ? {
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation()
                    onSelect(id)
                  },
                  onDoubleClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation()
                    onOpen(id)
                  }
                }
              : {})}
          >
            <mesh position={[0, 0.04, 0.08]}>
              <boxGeometry args={[2.05, 0.08, 1.66]} />
              <meshBasicMaterial color={lightMode ? '#c1bba8' : '#3c443d'} />
            </mesh>
            <mesh position={[0, 0.62, -0.34]}>
              <boxGeometry args={[1.45, 0.08, 0.62]} />
              <meshBasicMaterial color={lightMode ? '#806047' : '#604735'} />
            </mesh>
            {showCharacters && <MingCharacterRig sessionId={id} role="researcher" position={[0, 0, -0.66]} seated />}
          </group>
        )
      })}
    </group>
  )
}
