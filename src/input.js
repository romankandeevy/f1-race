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
addEventListener('blur', () => down.clear())

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
      throttle: any('KeyW', 'ArrowUp') ? 1 : 0,
      brake: any('KeyS', 'ArrowDown') ? 1 : 0,
      handbrake: any('Space'),
      steer: (any('KeyA', 'ArrowLeft') ? 1 : 0) - (any('KeyD', 'ArrowRight') ? 1 : 0),
      aero: this.aero,
      aeroZone: this.aeroZone,
      abs: this.abs,
      ersMode: this.ersMode,
      boost: any('ShiftLeft', 'ShiftRight'), // режим обгона («нитро»), пока держишь
    }
  },

  // одиночные нажатия: C, R, F, B, P…
  takePressed() {
    return pressed.splice(0, pressed.length)
  },
}
