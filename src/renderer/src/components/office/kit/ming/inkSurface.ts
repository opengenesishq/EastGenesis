import type { WebGLProgramParametersWithUniforms } from 'three'

export type InkSurface = 'paper' | 'wood' | 'tile' | 'water' | 'cloth' | 'stone'
export const inkClock = { value: 0 }

const INK_NOISE = `
varying vec3 vInkPosition;
uniform float uInkTime;
float inkNoise(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 39.425))) * 43758.5453);
}
float inkWash(vec3 p) {
  return sin(p.x * 2.3 + sin(p.z * 1.7)) * cos(p.y * 2.9 + p.z * .7);
}
`

const SURFACE_STROKES: Record<InkSurface, string> = {
  paper: 'float strokes = sin(p.x * 117.0 + p.y * 41.0 + p.z * 13.0) * .008;',
  wood: 'float strokes = sin((p.x + p.z) * 38.0 + sin(p.y * 4.0) * 2.0) * .028;',
  tile: 'float strokes = sin(p.y * 63.0 + p.z * 7.0) * .018;',
  water: 'float strokes = sin(p.x * 13.0 + p.z * 19.0 + uInkTime * .45) * .038;',
  cloth: 'float strokes = sin(p.y * 72.0 + sin(p.x * 17.0 + p.z * 8.0)) * .025;',
  stone: 'float strokes = sin(p.x * 53.0 + p.y * 41.0 + p.z * 29.0) * .012;'
}

/** Shared by authored palace batches and the live procedural surfaces. */
export function applyInkSurface(shader: WebGLProgramParametersWithUniforms, surface: InkSurface): void {
    shader.uniforms.uInkTime = inkClock
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vInkPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInkPosition = (modelMatrix * vec4(position, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${INK_NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 p = vInkPosition;
        ${SURFACE_STROKES[surface]}
        float grain = inkNoise(floor(p * 310.0));
        diffuseColor.rgb *= .974 + inkWash(p) * .025 + (grain - .5) * .026 + strokes;
      `)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        float inkRim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 5.0);
        gl_FragColor.rgb *= 1.0 - inkRim * .14;
      `)
}
