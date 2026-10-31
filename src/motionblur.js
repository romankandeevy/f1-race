// Размытие в движении (Рома 30.10: «картинка дрожит и резкая, хочу, чтобы на ходу всё вокруг было плавно»).
// На 60 кадрах окружение на скорости прыгает ступеньками: столб у трассы за кадр сдвигается на десятки точек, глаз видит
// рывки. Гоночные игры смазывают кадр по движению камеры — так делаем и мы: сцена рисуется в свою картинку (с тем же
// сглаживанием MSAA ×4 и глубиной), потом один проход по экрану: по глубине точки восстанавливаем её место в мире, смотрим,
// где она была на прошлом кадре, и усредняем цвет вдоль этого пути (6 выборок). Своё размытие — только от движения камеры:
// болид игрока едет вместе с камерой, поэтому ближнее (до NEAR0…NEAR1 м от камеры) не смазывается совсем, и выборки с
// ближнего не попадают в смаз дальнего (иначе болид «тёк» бы на фон). Длина смаза — как у кинокамеры с затвором 180°
// (половина пути за кадр, `SHUTTER`), не длиннее MAX_BLUR экрана. Камеру перенесли (R, смена вида, новый старт) — кадр без смаза.
// Выключено — рисуем как раньше, прямо на экран, без лишней работы. Тон и цвет (ACES, sRGB) — в этом же проходе.
import * as THREE from 'three'

const SAMPLES = 6
const NEAR0 = 7 // м: ближе — не смазываем (болид в кадре, кабина)
const NEAR1 = 16 // м: дальше — смаз полностью
const MAX_BLUR = 0.035 // доля экрана: потолок длины смаза
const JUMP = 15 // м за кадр: камеру перенесли — без смаза
export const BLUR_LEVELS = { off: 0, soft: 0.3, normal: 0.5 } // доля пути за кадр (затвор)

const vert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const frag = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 invViewProj;
uniform mat4 prevViewProj;
uniform float cameraNear;
uniform float cameraFar;
uniform float shutter;
varying vec2 vUv;
// насколько точка далеко (0 — ближе NEAR0, 1 — дальше NEAR1): по глубине вдоль взгляда, без матриц — дёшево для каждой выборки
float farK(float d) {
  return smoothstep(${NEAR0.toFixed(1)}, ${NEAR1.toFixed(1)}, -perspectiveDepthToViewZ(d, cameraNear, cameraFar));
}
void main() {
  vec4 base = texture2D(tColor, vUv);
  float d = texture2D(tDepth, vUv).x;
  float k = farK(d);
  vec2 vel = vec2(0.0);
  if (k > 0.0) {
    vec4 w = invViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 prev = prevViewProj * vec4(w.xyz / w.w, 1.0);
    vel = (vUv - (prev.xy / prev.w * 0.5 + 0.5)) * shutter * k;
  }
  float len = length(vel);
  vec4 sum = base;
  if (len > 0.0006) {
    if (len > ${MAX_BLUR}) vel *= ${MAX_BLUR} / len;
    float n = 1.0;
    for (int i = 0; i < ${SAMPLES}; i++) {
      vec2 uv = vUv + vel * (float(i) / ${(SAMPLES - 1).toFixed(1)} - 0.5);
      // выборка с ближнего (болид) в смаз дальнего не идёт
      float wgt = farK(texture2D(tDepth, uv).x);
      sum += texture2D(tColor, uv) * wgt;
      n += wgt;
    }
    sum /= n;
  }
  gl_FragColor = sum;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export function createMotionBlur(renderer) {
  const size = new THREE.Vector2()
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) })
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      tColor: { value: target.texture },
      tDepth: { value: target.depthTexture },
      invViewProj: { value: new THREE.Matrix4() },
      prevViewProj: { value: new THREE.Matrix4() },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 1000 },
      shutter: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
  quad.frustumCulled = false
  const quadScene = new THREE.Scene()
  quadScene.add(quad)
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const viewProj = new THREE.Matrix4()
  const prevPos = new THREE.Vector3()
  let fresh = true
  let level = 0

  return {
    set level(v) {
      level = v
      fresh = true
    },
    get level() {
      return level
    },
    // кадр без смаза (перенос камеры, смена вида, витрина)
    reset() {
      fresh = true
    },
    // calm — кадр без смаза (меню, пауза): картинка стоит, смазывать нечего
    render(scene, camera, calm = false) {
      if (!level) {
        renderer.render(scene, camera)
        fresh = true
        return
      }
      renderer.getDrawingBufferSize(size)
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y)
      camera.updateMatrixWorld()
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      const jump = prevPos.distanceTo(camera.position) > JUMP
      const u = mat.uniforms
      if (fresh || jump || calm) u.prevViewProj.value.copy(viewProj)
      u.invViewProj.value.copy(viewProj).invert()
      u.cameraNear.value = camera.near
      u.cameraFar.value = camera.far
      u.shutter.value = fresh || jump || calm ? 0 : level
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
      renderer.render(quadScene, quadCam)
      u.prevViewProj.value.copy(viewProj)
      prevPos.copy(camera.position)
      fresh = false
    },
  }
}
