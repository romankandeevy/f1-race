// Вид трассы (Рома 01.11: «всё невзрачное, иногда еду и ничего не вижу — куда и как; трасса днём выглядит не очень»).
// Было: асфальт — плитка 512 px с яркостью 42 из 255 (почти чёрный: настоящий битум втрое светлее), трава — ровный цвет без
// рисунка. Днём полотно сливалось с тенями и обочиной, а поворот читался только по белым линиям.
// Стало — поверхности рисуются шейдером в координатах мира (не зависят от развёртки модели, одинаково на всех трассах):
//  · асфальт светлее (как на фото трасс), с крупными пятнами ремонта/старения и мелким зерном. Накатанной резины по
//    гоночной линии и следов колёс на полотне нет (Рома 01.11: «убери полностью след колёс с трассы») — не возвращать;
//  · трава — полосы стрижки (как на трассах F1), пятна и оттенки.
// Дождь (weather.js) и ночное свечение (floodlights.js) работают как раньше: шейдер умножает цвет материала, а не
// подменяет его, и свечение берёт тот же рисунок.

const ASPHALT = /^(асфальт|asphalt)$/i
const GRASS = /^(grass|газон|трава)/i

const NOISE = /* glsl */ `
float lkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lkNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lkHash(i), lkHash(i + vec2(1.0, 0.0)), u.x), mix(lkHash(i + vec2(0.0, 1.0)), lkHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float lkFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * lkNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}`

// асфальт: множитель к цвету материала (материал белый, плитка зерна — map)
const ASPHALT_FN = /* glsl */ `
varying vec3 vLkWorld;
uniform float lkBase;
${NOISE}
vec3 lkAsphalt() {
  vec2 w = vLkWorld.xz;
  // крупные пятна: старый и свежий асфальт, ремонтные заплаты
  float big = lkFbm(w * 0.035);
  float mid = lkFbm(w * 0.22 + 31.0);
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
  float big = lkFbm(w * 0.03);
  float fine = lkNoise(w * 3.1);
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
