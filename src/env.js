import * as THREE from 'three'

export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.55).normalize()

// Небо рисуем в картинку: она и фон, и источник отражений на кузове.
function skyTexture() {
  const W = 1024
  const H = 512
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const grad = g.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, '#3f6fae')
  grad.addColorStop(0.35, '#86aed3')
  grad.addColorStop(0.5, '#d4e2ee')
  grad.addColorStop(0.505, '#7a7d72')
  grad.addColorStop(1, '#4a4d46')
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)

  // солнце там, откуда падает свет
  const u = Math.atan2(SUN_DIR.z, SUN_DIR.x) / (Math.PI * 2) + 0.5
  const v = Math.asin(SUN_DIR.y) / Math.PI + 0.5
  const sx = u * W
  const sy = (1 - v) * H
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 90)
  glow.addColorStop(0, 'rgba(255,250,235,1)')
  glow.addColorStop(0.12, 'rgba(255,240,205,0.9)')
  glow.addColorStop(1, 'rgba(255,240,205,0)')
  g.fillStyle = glow
  g.fillRect(sx - 120, sy - 120, 240, 240)

  const tex = new THREE.CanvasTexture(c)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function createEnvironment(renderer, scene) {
  const sky = skyTexture()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromEquirectangular(sky).texture
  scene.environmentIntensity = 0.9
  scene.background = sky
  scene.backgroundIntensity = 1
  scene.fog = new THREE.Fog(0xcfdde9, 700, 3200)
  pmrem.dispose()

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024) // на квадрат 28×28 м этого хватает: 2,7 см на точку
  const s = 14
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 140 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.04
  scene.add(sun, sun.target)

  const fill = new THREE.HemisphereLight(0xbcd4ee, 0x5a5d54, 0.45)
  scene.add(fill)

  const fogDry = new THREE.Color(0xcfdde9)
  const fogWet = new THREE.Color(0x8b939c)
  // тень едет за болидом
  return {
    // дождь (weather.js): 0 — солнце, 1 — ливень: свет тусклее, небо серее, туман ближе
    setGloom(k) {
      sun.intensity = 2.6 * (1 - 0.62 * k)
      fill.intensity = 0.45 * (1 + 0.35 * k)
      scene.backgroundIntensity = 1 - 0.55 * k
      scene.environmentIntensity = 0.9 * (1 - 0.3 * k)
      scene.fog.color.copy(fogDry).lerp(fogWet, k)
      scene.fog.near = 700 - 560 * k
      scene.fog.far = 3200 - 2300 * k
    },
    follow(pos) {
      sun.target.position.copy(pos)
      sun.position.copy(pos).addScaledVector(SUN_DIR, 70)
    },
  }
}
