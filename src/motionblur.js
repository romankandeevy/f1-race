// Размытие в движении (Рома 30.10: «картинка дрожит и резкая, хочу, чтобы на ходу всё вокруг было плавно»).
// На 60 кадрах окружение на скорости прыгает ступеньками: столб у трассы за кадр сдвигается на десятки точек, глаз видит
// рывки. Гоночные игры смазывают кадр по движению камеры — так делаем и мы: сцена рисуется в свою картинку (с тем же
// сглаживанием MSAA ×4 и глубиной), потом один проход по экрану: по глубине точки восстанавливаем её место в мире, смотрим,
// где она была на прошлом кадре, и усредняем цвет вдоль этого пути (6 выборок). Своё размытие — только от движения камеры:
// болид игрока едет вместе с камерой, поэтому ближнее (до NEAR0…NEAR1 м от камеры) не смазывается совсем, и выборки с
// ближнего не попадают в смаз дальнего (иначе болид «тёк» бы на фон). Длина смаза — как у кинокамеры с затвором 180°
// (половина пути за кадр, `SHUTTER`), не длиннее MAX_BLUR экрана. Камеру перенесли (R, смена вида, новый старт) — кадр без смаза.
// Выключено — кадр всё равно идёт через проход (цветокоррекция, 01.11), только без смаза. Тон (ACES) — при рисовании сцены, sRGB — в этом проходе.
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

const SAMPLES = 12 // выборок вдоль смаза; каждая точка начинает со своего сдвига (шум) — без «ступенек» на скорости
const NEAR0 = 7 // м: ближе — не смазываем (болид в кадре, кабина)
const NEAR1 = 16 // м: дальше — смаз полностью
const MAX_BLUR = 0.035 // доля экрана: потолок длины смаза
const JUMP = 15 // м за кадр: камеру перенесли — без смаза
// Свечение (Рома 01.11: «свечение»): яркое (уже после тона, 0…1) расплывается ореолом — UnrealBloomPass в четверть
// разрешения, складывается в картинку до цветокоррекции. Ночью — прожекторы, огни, светящаяся разметка; днём слабо —
// только блики на кузове (небо не должно светиться).
const BLOOM = { day: { strength: 0.12, threshold: 0.93, radius: 0.3 }, night: { strength: 0.5, threshold: 0.94, radius: 0.35 } }
const GRADE = { saturation: 1.1, contrast: 1.06, vignette: 0.22 }
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
    // сдвиг выборок для каждой точки свой (interleaved gradient noise): вместо ровных копий кадра — мелкое зерно, глаз его
    // не видит (Рома 31.10: «на ходу всё пиксельное» — 6 ровных копий на скорости давали ступеньки)
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    for (int i = 0; i < ${SAMPLES}; i++) {
      vec2 uv = vUv + vel * ((float(i) + jit) / ${SAMPLES.toFixed(1)} - 0.5);
      // выборка с ближнего (болид) в смаз дальнего не идёт
      float wgt = farK(texture2D(tDepth, uv).x);
      sum += texture2D(tColor, uv) * wgt;
      n += wgt;
    }
    sum /= n;
  }
  gl_FragColor = sum;
  #include <colorspace_fragment>
  // цветокоррекция (Рома 01.11: «всё невзрачное») — уже в sRGB, как у фото: чуть насыщеннее и контрастнее,
  // края кадра темнее (виньетка) — взгляд держится на трассе впереди
  vec3 c = gl_FragColor.rgb;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, ${GRADE.saturation.toFixed(3)});
  c = (c - 0.5) * ${GRADE.contrast.toFixed(3)} + 0.5;
  vec2 vq = vUv - 0.5;
  c *= 1.0 - ${GRADE.vignette.toFixed(3)} * smoothstep(0.2, 0.75, dot(vq, vq) * 2.2);
  gl_FragColor.rgb = clamp(c, 0.0, 1.0);
}`

export function createMotionBlur(renderer) {
  const size = new THREE.Vector2()
  // 01.11 (Рома: «всё подлагивает, дёргается»; замер на Спа в гонке: кадр упирался в видеокарту на «Максимуме»):
  // картинка кадра — 8 бит с гамма-кодированием (sRGB), а не 16 бит: тон (ACES) уже в ней, яркость ≤ 1, пиксели те же
  // (проверено), а памяти и чтения вдвое меньше. Сглаживание — 4 выборки, но 2, когда картинка и так ≥ 1,75 экрана
  // (сглаживание сверхразрешением уже есть) — см. render
  // Цвет для three.js — линейный (тон он пишет как есть), а хранит видеокарта в SRGB8_ALPHA8 — сама кодирует при записи и
  // раскодирует при чтении: точность в тёмном как у sRGB, без полос. colorSpace: SRGB здесь нельзя — с isXRRenderTarget
  // three тогда кодирует ещё и в шейдере (вдвое, картинка светлее)
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.UnsignedByteType, internalFormat: 'SRGB8_ALPHA8', depthTexture: new THREE.DepthTexture(1, 1) })
  target.texture.colorSpace = THREE.LinearSRGBColorSpace
  // Тон (ACES) — прямо при рисовании сцены, как на экране, ДО сглаживания (Рома 31.10: «лесенки на трассе»). three.js тонирует
  // только при рисовании на экран (или в XR-цель); в свою картинку кадр шёл в «сырой» яркости, и MSAA усреднял край яркой
  // белой линии (ночью она ещё светится, яркость ≫ 1) с асфальтом уже там: точка, на четверть закрытая линией, после тона
  // становилась почти белой — перехода нет, ступеньки. Пометка XR-цели включает тон для этой картинки; цвет в ней линейный.
  target.isXRRenderTarget = true
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
    toneMapped: false, // тон уже в картинке (см. выше); здесь — только перевод в sRGB
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
  let bloomOn = true
  let night = 0
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0, 0, 1)
  const bloomSize = new THREE.Vector2()

  return {
    set level(v) {
      level = v
      fresh = true
    },
    get target() {
      return target // для проверок (__game.post.target)
    },
    get level() {
      return level
    },
    set bloom(v) {
      bloomOn = !!v
    },
    // время суток: 0 — день, 1 — ночь (сила свечения)
    set night(k) {
      night = k
    },
    // кадр без смаза (перенос камеры, смена вида, витрина)
    reset() {
      fresh = true
    },
    // calm — кадр без смаза (меню, пауза): картинка стоит, смазывать нечего
    render(scene, camera, calm = false) {
      renderer.getDrawingBufferSize(size)
      const samples = renderer.getPixelRatio() >= 1.75 ? 2 : 4
      if (target.samples !== samples) {
        target.samples = samples
        target.dispose() // пересоздастся с новым числом выборок
      }
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y)
      camera.updateMatrixWorld()
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      const jump = prevPos.distanceTo(camera.position) > JUMP
      const u = mat.uniforms
      if (fresh || jump || calm) u.prevViewProj.value.copy(viewProj)
      u.invViewProj.value.copy(viewProj).invert()
      u.cameraNear.value = camera.near
      u.cameraFar.value = camera.far
      // размытие выключено — кадр всё равно идёт через этот проход (цветокоррекция), только без смаза
      u.shutter.value = fresh || jump || calm || !level ? 0 : level
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      // свечение — только ночью (01.11, «что-то лагает»: днём сила 0,12 почти не видна, а 10 проходов по кадру стоили
      // заметно). Размер — от окна, а не от картинки: на «Максимуме» (×2) размытое свечение не нужно рисовать вчетверо крупнее
      if (bloomOn && night > 0.3) {
        const w = Math.round(innerWidth / 2)
        const h = Math.round(innerHeight / 2)
        if (bloomSize.x !== w || bloomSize.y !== h) {
          bloomSize.set(w, h)
          bloom.setSize(w, h) // сам делит ещё пополам — четверть кадра
        }
        const a = BLOOM.day
        const b = BLOOM.night
        bloom.strength = a.strength + (b.strength - a.strength) * night
        bloom.threshold = a.threshold + (b.threshold - a.threshold) * night
        bloom.radius = a.radius + (b.radius - a.radius) * night
        target.isXRRenderTarget = false // проходы свечения — без тона
        bloom.render(renderer, null, target, 0, false)
        target.isXRRenderTarget = true
      }
      renderer.setRenderTarget(null)
      renderer.render(quadScene, quadCam)
      u.prevViewProj.value.copy(viewProj)
      prevPos.copy(camera.position)
      fresh = false
    },
  }
}
