// Клавиатура → один набор чисел для физики. force нужен для проверок из консоли.
const down = new Set()
const pressed = []

addEventListener('keydown', (e) => {
  // печатают название своей настройки — это не управление болидом
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return
  if (e.repeat) return
  down.add(e.code)
  pressed.push(e.code)
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
})
addEventListener('keyup', (e) => down.delete(e.code))
addEventListener('blur', () => {
  down.clear()
  view.dragging = false
})

// Обзор камерой (Рома 29.10): мышь с зажатой кнопкой — свободный обзор, колесо — расстояние; стрелки смотрят вбок и назад.
// Рулить и жать педали стрелками больше нельзя — только W A S D. Тянуть можно только за картинку, не за панели и кнопки.
const view = { dragging: false, dx: 0, dy: 0, wheel: 0 }
const onScene = (e) => e.target instanceof HTMLCanvasElement && e.target.id !== 'minimap'
addEventListener('pointerdown', (e) => {
  if ((e.button !== 0 && e.button !== 2) || !onScene(e)) return
  view.dragging = true
  e.target.setPointerCapture?.(e.pointerId)
})
addEventListener('pointermove', (e) => {
  if (!view.dragging) return
  view.dx += e.movementX
  view.dy += e.movementY
})
const stopDrag = () => {
  view.dragging = false
}
addEventListener('pointerup', stopDrag)
addEventListener('pointercancel', stopDrag)
addEventListener('contextmenu', (e) => {
  if (onScene(e)) e.preventDefault()
})
addEventListener('wheel', (e) => {
  if (onScene(e)) view.wheel += e.deltaY
}, { passive: true })

const any = (...codes) => codes.some((c) => down.has(c))

export const input = {
  force: null,
  aero: false, // просьба включить режим прямой (F); main сбрасывает, когда крылья закрылись
  aeroZone: true, // болид в зоне прямой (ставит main по оси трассы)
  abs: false, // ABS включает сам игрок (B)
  ersMode: 'balanced', // режим батареи, клавиши 1–4

  read() {
    if (this.force) return { ersMode: this.ersMode, ...this.force, aero: this.aero, aeroZone: this.aeroZone, abs: this.abs }
    return {
      throttle: any('KeyW') ? 1 : 0,
      brake: any('KeyS') ? 1 : 0,
      handbrake: any('Space'),
      steer: (any('KeyA') ? 1 : 0) - (any('KeyD') ? 1 : 0),
      aero: this.aero,
      aeroZone: this.aeroZone,
      abs: this.abs,
      ersMode: this.ersMode,
      boost: any('ShiftLeft', 'ShiftRight'), // режим обгона («нитро»), пока держишь
    }
  },

  // обзор за кадр: мышь (сдвиг с прошлого вызова), колесо и стрелки (держат — камера смотрит влево, вправо, назад)
  takeLook() {
    const r = { dragging: view.dragging, dx: view.dx, dy: view.dy, wheel: view.wheel, arrows: { left: any('ArrowLeft'), right: any('ArrowRight'), back: any('ArrowDown') } }
    view.dx = view.dy = view.wheel = 0
    return r
  },

  // одиночные нажатия: C, R, F, B, P…
  takePressed() {
    return pressed.splice(0, pressed.length)
  },
}
