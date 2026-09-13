import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Fog,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer
} from 'three'

let attempted = false

/**
 * Compiles the small set of shaders used by the Office boot scene while the
 * list view is idle. This work is intentionally scheduled before navigation;
 * it must never run from the Office click handler.
 */
export function prepareOfficeGpu(): void {
  if (attempted || typeof document === 'undefined') return
  attempted = true

  try {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    })
    renderer.setPixelRatio(1)
    renderer.setSize(32, 32, false)

    const scene = new Scene()
    scene.fog = new Fog('#1c2024', 18, 42)
    scene.add(new AmbientLight('#ffffff', 1))
    scene.add(new DirectionalLight('#ffffff', 1))
    const basicGeometry = new BoxGeometry(1, 1, 1)
    const basicMaterial = new MeshBasicMaterial({ color: '#202832' })
    scene.add(new Mesh(basicGeometry, basicMaterial))
    const standardGeometry = new BoxGeometry(0.5, 0.5, 0.5)
    const standardMaterial = new MeshStandardMaterial({ color: '#52616a', roughness: 0.72 })
    const standard = new Mesh(standardGeometry, standardMaterial)
    standard.position.set(0, 0, -1)
    scene.add(standard)

    const camera = new PerspectiveCamera(45, 1, 0.1, 10)
    camera.position.set(0, 0, 3)
    renderer.compile(scene, camera)
    renderer.render(scene, camera)
    basicGeometry.dispose()
    basicMaterial.dispose()
    standardGeometry.dispose()
    standardMaterial.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
  } catch {
    // Office still opens normally when WebGL is unavailable during background prefetch.
  }
}
