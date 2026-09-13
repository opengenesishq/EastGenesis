import { useEffect, useMemo, useRef, type ComponentRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Vector3 } from 'three'

interface Props {
  position?: [number, number, number]
  target?: [number, number, number]
  auto?: boolean
  reducedMotion?: boolean
  minDistance?: number
  maxDistance?: number
  /** An explicit preset can reset the same pose after a user orbit. */
  requestId?: number
  onSettledChange?: (settled: boolean) => void
}

/** Presets move once; user gestures own the camera until the next explicit preset. */
export default function CameraRig({ position, target, auto = false, reducedMotion = false,
  minDistance = 1, maxDistance = 32, requestId = 0, onSettledChange }: Props): React.JSX.Element {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const { gl } = useThree()
  const transition = useRef(true)
  const appliedRequest = useRef<number | null>(null)
  const settled = useRef<boolean | null>(null)
  const notify = useRef(onSettledChange)
  notify.current = onSettledChange
  const desired = useMemo(() => new Vector3(), [])
  const desiredPosition = useMemo(() => new Vector3(), [])
  const pose = [position?.join(',') ?? '0.28,4.58,9.28', target?.join(',') ?? '0,0.6,0', requestId].join('|')
  const markSettled = (value: boolean): void => {
    if (settled.current === value) return
    settled.current = value; notify.current?.(value)
  }
  const takeControl = (): void => {
    transition.current = false
    gl.domElement.dataset.officeCameraMode = 'free'
    markSettled(true)
  }
  useEffect(() => {
    if (appliedRequest.current === requestId) return
    appliedRequest.current = requestId
    desiredPosition.fromArray(position ?? [0.28, 4.58, 9.28])
    desired.fromArray(target ?? [0, 0.6, 0])
    transition.current = true
    gl.domElement.dataset.officeCameraMode = 'preset'
    markSettled(false)
  }, [pose, requestId, desired, desiredPosition, gl])

  useEffect(() => {
    const controls = controlsRef.current
    const canvas = gl.domElement
    if (!controls) return
    canvas.tabIndex = 0
    canvas.setAttribute('aria-label', '3D 场景：拖动环绕，右键或方向键平移，滚轮或加减键缩放，Home 返回预设')
    controls.listenToKeyEvents(canvas)
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Home') {
        event.preventDefault(); transition.current = true; markSettled(false)
        canvas.dataset.officeCameraMode = 'preset'; return
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'].includes(event.key)) return
      takeControl()
      if (!['+', '=', '-', '_'].includes(event.key)) return
      event.preventDefault()
      const offset = controls.object.position.clone().sub(controls.target)
      const distance = Math.max(minDistance, Math.min(maxDistance,
        offset.length() * (event.key === '+' || event.key === '=' ? 0.88 : 1.12)))
      controls.object.position.copy(controls.target).add(offset.setLength(distance))
      controls.update()
    }
    const focus = (): void => canvas.focus({ preventScroll: true })
    canvas.addEventListener('keydown', keydown)
    canvas.addEventListener('pointerdown', focus)
    return () => {
      controls.stopListenToKeyEvents()
      canvas.removeEventListener('keydown', keydown)
      canvas.removeEventListener('pointerdown', focus)
    }
  }, [gl, minDistance, maxDistance])

  useFrame((_, delta) => {
    const controls = controlsRef.current
    if (!controls || !transition.current) return
    const amount = reducedMotion ? 1 : 1 - Math.pow(0.001, delta)
    controls.object.position.lerp(desiredPosition, amount)
    controls.target.lerp(desired, amount)
    const finished = controls.object.position.distanceToSquared(desiredPosition) <= 0.0025 &&
      controls.target.distanceToSquared(desired) <= 0.0025
    if (finished) {
      controls.object.position.copy(desiredPosition); controls.target.copy(desired)
      transition.current = false
    }
    controls.update(); markSettled(finished)
  })
  return <OrbitControls ref={controlsRef} enablePan minDistance={minDistance} maxDistance={maxDistance}
    minPolarAngle={0.04} maxPolarAngle={Math.PI / 2 - 0.015} enableDamping={!reducedMotion}
    dampingFactor={0.1} autoRotate={auto && !reducedMotion} autoRotateSpeed={0.35} onStart={takeControl} />
}
