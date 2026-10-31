import * as THREE from 'three'

export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.55).normalize()

// Ночью общий свет почти выключен (луна, тёмный город): трассу освещают только её фонари — floodlights.js.

// Цвета дня и ночи. Небо, солнце, заливка, туман смешиваются по `night` (0 — день, 1 — ночь),
// дождь (`gloom`) сверху — отдельно (weather.js).
const DAY_SKY = [[0, '#3f6fae'], [0.35, '#86aed3'], [0.5, '#d4e2ee'], [0.505, '#7a7d72'], [1, '#4a4d46']]
const NIGHT_SKY = [[0, '#05070f'], [0.35, '#0b1224'], [0.5, '#1c2740'], [0.505, '#15171c'], [1, '#08090c']]
const SUN_DAY = new THREE.Color(0xfff1dc)
const SUN_NIGHT = new THREE.Color(0x9fb6e0) // луна — холодный слабый свет
const FILL_DAY = new THREE.Color(0xbcd4ee)
const FILL_NIGHT = new THREE.Color(0x2a3d63)
const FILL_GROUND_DAY = new THREE.Color(0x5a5d54)
const FILL_GROUND_NIGHT = new THREE.Color(0x101318)
const FOG_DAY = new THREE.Color(0xcfdde9)
const FOG_NIGHT = new THREE.Color(0x0d1220)
const FOG_WET = new THREE.Color(0x8b939c)

// Небо рисуем в картинку: она и фон, и источник отражений на кузове.
function skyTexture(night) {
  const W = 1024
  const H = 512
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, 0, H)
  DAY_SKY.forEach(([at, day], i) => {
    const col = new THREE.Color(day).lerp(new THREE.Color(NIGHT_SKY[i][1]), night)
    grad.addColorStop(at, '#' + col.getHexString())
  })
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)

  // солнце там, откуда падает свет (ночью — луна)
  const u = Math.atan2(SUN_DIR.z, SUN_DIR.x) / (Math.PI * 2) + 0.5
  const v = Math.asin(SUN_DIR.y) / Math.PI + 0.5
  const sx = u * W
  const sy = (1 - v) * H
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, night > 0.5 ? 46 : 90)
  const warm = night > 0.5 ? 'rgba(200,216,245,' : 'rgba(255,240,205,'
  glow.addColorStop(0, warm + '1)')
  glow.addColorStop(0.12, warm + (0.9 * (1 - night) + 0.5 * night) + ')')
  glow.addColorStop(1, warm + '0)')
  g.fillStyle = glow
  g.fillRect(sx - 120, sy - 120, 240, 240)

  // звёзды — только в верхней части неба, ночью
  if (night > 0.05) {
    for (let i = 0; i < 320; i++) {
      const y = Math.random() ** 1.6 * H * 0.5
      const x = Math.random() * W
      g.fillStyle = `rgba(230,238,255,${(0.25 + 0.75 * Math.random()) * night})`
      g.fillRect(x, y, Math.random() < 0.1 ? 2 : 1, Math.random() < 0.1 ? 2 : 1)
    }
  }

  const tex = new THREE.CanvasTexture(c)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function createEnvironment(renderer, scene) {
  const pmrem = new THREE.PMREMGenerator(renderer)
  let night = 0
  let gloom = 0
  let sky = null
  let envTarget = null
  let skyNight = -1 // для какой ночи нарисовано небо

  // небо и отражения — перерисовываем, только когда время суток сменилось
  function rebuildSky() {
    if (skyNight === night) return
    skyNight = night
    const next = skyTexture(night)
    const nextEnv = pmrem.fromEquirectangular(next)
    sky?.dispose()
    envTarget?.dispose()
    sky = next
    envTarget = nextEnv
    scene.background = sky
    scene.environment = envTarget.texture
  }

  scene.environmentIntensity = 0.9
  scene.backgroundIntensity = 1
  scene.fog = new THREE.Fog(FOG_DAY.clone(), 700, 3200)
  rebuildSky()

  const sun = new THREE.DirectionalLight(SUN_DAY.clone(), 2.6)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024) // на квадрат 28×28 м этого хватает: 2,7 см на точку
  const s = 14
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 140 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.04
  scene.add(sun, sun.target)

  // оси карты теней (как у камеры солнца: смотрит вдоль −SUN_DIR, верх — мировой Y) и размер её точки
  const TEXEL = (2 * s) / sun.shadow.mapSize.x
  const SHADOW_X = new THREE.Vector3(0, 1, 0).cross(SUN_DIR).normalize()
  const SHADOW_Y = SUN_DIR.clone().cross(SHADOW_X)

  const fill = new THREE.HemisphereLight(FILL_DAY.clone(), FILL_GROUND_DAY.clone(), 0.45)
  scene.add(fill)

  const fogColor = new THREE.Color()
  // один раз на кадр пересчитываем свет по дню/ночи и дождю; ничего не создаём
  function light() {
    sun.color.copy(SUN_DAY).lerp(SUN_NIGHT, night)
    sun.intensity = (2.6 * (1 - night) + 0.08 * night) * (1 - 0.62 * gloom)
    // ночью тени дают фонари трассы; тень от луны не считаем (её почти не видно, а проход теней дорогой)
    sun.castShadow = night < 0.5
    fill.color.copy(FILL_DAY).lerp(FILL_NIGHT, night)
    fill.groundColor.copy(FILL_GROUND_DAY).lerp(FILL_GROUND_NIGHT, night)
    fill.intensity = (0.45 * (1 - night) + 0.3 * night) * (1 + 0.35 * gloom)
    scene.backgroundIntensity = 1 - 0.55 * gloom
    scene.environmentIntensity = 0.9 * (1 - 0.3 * gloom) * (1 - 0.45 * night)
    fogColor.copy(FOG_DAY).lerp(FOG_NIGHT, night).lerp(FOG_WET, gloom)
    scene.fog.color.copy(fogColor)
    // ночью туман не ближе, чем днём: трасса освещена, впереди должно быть видно далеко
    scene.fog.near = 700 - 560 * gloom
    scene.fog.far = 3200 - 2300 * gloom
  }
  light()

  // тень едет за болидом
  return {
    // дождь (weather.js): 0 — сухо, 1 — ливень: свет тусклее, небо серее, туман ближе
    setGloom(k) {
      if (k === gloom) return
      gloom = k
      light()
    },
    // время суток: 0 — день, 1 — ночь (небо, луна, туман, заливка)
    setNight(k) {
      if (k === night) return
      night = k
      light()
      rebuildSky()
    },
    // Рома 30.10: «картинка дрожит» — тень ехала за болидом плавно, и карта теней каждый кадр сдвигалась на доли своей
    // точки: края теней (болид, деревья, ограждения) мерцали и ползли. Теперь центр карты шагает ровно по её сетке (2,7 см).
    follow(pos) {
      const a = Math.round(pos.dot(SHADOW_X) / TEXEL) * TEXEL
      const b = Math.round(pos.dot(SHADOW_Y) / TEXEL) * TEXEL
      const c = pos.dot(SUN_DIR)
      sun.target.position.copy(SHADOW_X).multiplyScalar(a).addScaledVector(SHADOW_Y, b).addScaledVector(SUN_DIR, c)
      sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 70)
    },
  }
}
