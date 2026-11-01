// Вид трассы (Рома 01.11: «всё невзрачное, иногда еду и ничего не вижу — куда и как; трасса днём выглядит не очень»).
// Было: асфальт — плитка 512 px с яркостью 42 из 255 (почти чёрный: настоящий битум втрое светлее), трава — ровный цвет без
// рисунка. Днём полотно сливалось с тенями и обочиной, а поворот читался только по белым линиям.
// Стало — поверхности рисуются шейдером в координатах мира (не зависят от развёртки модели, одинаково на всех трассах):
//  · асфальт светлее (как на фото трасс), с крупными пятнами ремонта/старения и мелким зерном. Накатанной резины по
//    гоночной линии и следов колёс на полотне нет (Рома 01.11: «убери полностью след колёс с трассы») — не возвращать;
//  · трава — полосы стрижки (как на трассах F1), пятна и оттенки.
// Дождь (weather.js) и ночное свечение (floodlights.js) работают как раньше: шейдер умножает цвет материала, а не
// подменяет его, и свечение берёт тот же рисунок.
import * as THREE from 'three'

const ASPHALT = /^(асфальт|asphalt)$/i
const GRASS = /^(grass|газон|трава)/i

// Шум — из готовой картинки (01.11, Рома: «что-то лагает»): шумы считались в каждой точке кадра — 4 слоя × 4 соседа,
// у асфальта ещё раз столько же, около 50 синусов на точку; на «Максимуме» это ~5 млн точек асфальта и травы за кадр.
// Теперь один раз при загрузке рисуется бесшовная картинка 256×256 (R, G — два разных fbm по 4 слоя, B — мелкий шум),
// а шейдер берёт из неё 2–3 выборки. Рисунок тот же по характеру, цена — как у обычной текстуры.
const TEX = 256
function noiseTexture() {
  const out = new Uint8Array(TEX * TEX * 4)
  // бесшовный value noise с периодом p клеток на картинку
  const layer = (p, seed) => {
    const g = new Float32Array(p * p)
    let x = seed * 9301 + 49297
    for (let i = 0; i < p * p; i++) {
      x = (x * 16807) % 2147483647
      g[i] = x / 2147483647
    }
    const at = (i, j) => g[((j % p) + p) % p * p + (((i % p) + p) % p)]
    return (u, v) => {
      const fx = u * p
      const fy = v * p
      const i = Math.floor(fx)
      const j = Math.floor(fy)
      let tx = fx - i
      let ty = fy - j
      tx = tx * tx * (3 - 2 * tx)
      ty = ty * ty * (3 - 2 * ty)
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx
      const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx
      return a + (b - a) * ty
    }
  }
  const fbm = (seed) => {
    const ls = [4, 8, 16, 32].map((p, o) => layer(p, seed + o))
    return (u, v) => ls[0](u, v) * 0.5 + ls[1](u, v) * 0.25 + ls[2](u, v) * 0.125 + ls[3](u, v) * 0.0625
  }
  const r = fbm(1)
  const g = fbm(11)
  const b = layer(64, 21)
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const u = x / TEX
      const v = y / TEX
      const k = (y * TEX + x) * 4
      out[k] = Math.round((r(u, v) / 0.9375) * 255)
      out[k + 1] = Math.round((g(u, v) / 0.9375) * 255)
      out[k + 2] = Math.round(b(u, v) * 255)
      out[k + 3] = 255
    }
  }
  const t = new THREE.DataTexture(out, TEX, TEX)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.needsUpdate = true
  return t
}
let noiseTex = null
const lkNoise = { value: null }

// fbm на картинке — 4 клетки шума на её сторону (r, g — шкала 0…1 как у прежнего lkFbm × 1,07)
const NOISE = /* glsl */ `
uniform sampler2D lkNoiseTex;
float lkFbmR(vec2 p) { return texture2D(lkNoiseTex, p * 0.25).r * 0.9375; }
float lkFbmG(vec2 p) { return texture2D(lkNoiseTex, p * 0.25).g * 0.9375; }
float lkFine(vec2 p) { return texture2D(lkNoiseTex, p * 0.015625).b; }`

// асфальт: множитель к цвету материала (материал белый, плитка зерна — map)
const ASPHALT_FN = /* glsl */ `
varying vec3 vLkWorld;
uniform float lkBase;
${NOISE}
vec3 lkAsphalt() {
  vec2 w = vLkWorld.xz;
  // крупные пятна: старый и свежий асфальт, ремонтные заплаты
  float big = lkFbmR(w * 0.035);
  float mid = lkFbmG(w * 0.22 + 31.0);
  float k = 1.0 + (big - 0.5) * 0.34 + (mid - 0.5) * 0.12;
  // мелкое зерно — та же плитка, что была (теперь в метрах мира, 4 м на плитку)
  float grain = texture2D(map, w * 0.25).r / 0.024;
  k *= mix(1.0, clamp(grain, 0.4, 1.8), 0.45);
  vec3 c = vec3(lkBase) * k;
  // тёплый оттенок старых участков, холодный — свежих
  c *= mix(vec3(1.03, 1.0, 0.96), vec3(0.97, 0.99, 1.03), big);
  return c;
}`

// трава: множитель к цвету материала
const GRASS_FN = /* glsl */ `
varying vec3 vLkWorld;
${NOISE}
vec3 lkGrass() {
  vec2 w = vLkWorld.xz;
  // полосы стрижки: 6 м, повёрнуты на 30°; край полосы мягкий
  float u = dot(w, vec2(0.866, 0.5)) / 6.0;
  float stripe = smoothstep(0.42, 0.58, abs(fract(u) - 0.5) * 2.0);
  float big = lkFbmR(w * 0.03 + 0.37);
  float fine = lkFine(w * 3.1);
  float k = mix(0.86, 1.1, stripe) * (0.85 + 0.3 * big) * (0.94 + 0.12 * fine);
  // выгоревшие пятна желтее
  vec3 tint = mix(vec3(0.92, 1.03, 0.86), vec3(1.12, 1.04, 0.78), smoothstep(0.55, 0.8, big));
  return tint * k;
}`

const WORLD_VARYING = /* glsl */ `
#include <worldpos_vertex>
vLkWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`

// яркость асфальта: днём как на фото трасс; ночью темнее — под прожекторами (floodlights.js) светлый асфальт выгорал в белое
const BASE_DAY = 0.1
const BASE_NIGHT = 0.024 // как прежняя плитка: ночь Роме нравилась
const lkBase = { value: BASE_DAY }

function asphaltShader(m) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.lkBase = lkBase
    sh.uniforms.lkNoiseTex = lkNoise
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLkWorld;')
      .replace('#include <worldpos_vertex>', WORLD_VARYING)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\n' + ASPHALT_FN)
      .replace('#include <map_fragment>', 'vec3 lkC = lkAsphalt();\ndiffuseColor.rgb *= lkC;')
      // ночное свечение (floodlights.js) было подобрано под прежнюю тёмную плитку (~0,024) — держим его той же силы, рисунок — новый
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= lkC * (0.024 / lkBase);')
  }
  m.customProgramCacheKey = () => 'lk-asphalt'
  m.needsUpdate = true
}

function grassShader(m) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.lkNoiseTex = lkNoise
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLkWorld;')
      .replace('#include <worldpos_vertex>', WORLD_VARYING)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GRASS_FN)
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec3 lkC = lkGrass();\ndiffuseColor.rgb *= lkC;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= lkC;')
  }
  m.customProgramCacheKey = () => 'lk-grass'
  m.needsUpdate = true
}

// время суток: 0 — день, 1 — ночь
export function setLookNight(k) {
  lkBase.value = BASE_DAY + (BASE_NIGHT - BASE_DAY) * k
}

// root — сцена трассы (gltf.scene)
export function dressCircuit(root) {
  noiseTex ??= noiseTexture()
  lkNoise.value = noiseTex
  root.updateMatrixWorld(true)
  const done = new Set()
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const m of [].concat(o.material)) {
      if (ASPHALT.test(m.name) && m.map) {
        if (!done.has(m)) asphaltShader(m)
        done.add(m)
      } else if (GRASS.test(m.name) && !o.isInstancedMesh && !done.has(m)) {
        grassShader(m)
        done.add(m)
      }
    }
  })
}
