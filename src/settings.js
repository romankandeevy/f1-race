// Настройки игрока (главное меню или пауза → «Настройки»). Хранятся в localStorage и применяются сразу, без перезапуска.
// Читает и пишет только этот файл; кто что-то применяет — подписывается через onChange (см. main.js).
const KEY = 'f1-race.settings.v1'

// Качество: масштаб картинки (точек на пиксель экрана, не больше родного) и тени. Главная цена игры — закраска точек.
export const QUALITY = {
  // ratio — во сколько раз картинка больше экрана (на обычном мониторе тоже: потом браузер её ужимает — самое гладкое
  // сглаживание; Рома 31.10: «на максимуме всё равно пиксельное»), shadow — размер карты теней
  low: { name: 'Низкое', ratio: 1, shadows: false, shadow: 1024, about: 'Без теней, картинка в обычном размере. Для слабых видеокарт и тихой работы вентилятора.' },
  medium: { name: 'Среднее', ratio: 1.25, shadows: true, shadow: 1024, about: 'Тени есть, картинка чуть мягче родной.' },
  high: { name: 'Высокое', ratio: 1.5, shadows: true, shadow: 2048, about: 'Рекомендуется: картинка в полтора раза больше экрана (гладкие края) и чёткие тени.' },
  ultra: { name: 'Максимум', ratio: 2, shadows: true, shadow: 4096, about: 'Картинка вдвое больше экрана и самые чёткие тени — края без лесенки. Нужна хорошая видеокарта, ноутбук греется.' },
}

// звук мотора на выбор (sound.js ENGINES): все — из физического симулятора engine-sim, выбирают на слух
export const ENGINE_SOUNDS = {
  ls: { name: 'V8 большой (GM LS)', about: 'Низкий басовитый V8 до 6500 об/мин — больше всего рыка.' },
  v10: { name: 'V10 (Lexus LFA)', about: 'Высокий злой V10 до 9000 об/мин — ближе всего к F1 2000-х.' },
  f136: { name: 'V8 Ferrari 458', about: 'V8 Ferrari F136 до 9000 об/мин: звонкий, с рыком на сбросе.' },
}

export const DEFAULTS = {
  quality: 'high', // low | medium | high | ultra
  fps: 60, // 30 | 60 | 120 | 0 (без лимита)
  blur: 'normal', // размытие в движении: off | soft | normal (motionblur.js)
  volume: 100, // 0…100, общая громкость
  music: 50, // 0…100, музыка в меню (menuaudio.js)
  uiSound: 70, // 0…100, звуки интерфейса: щелчки по пунктам меню
  engineSound: 'ls', // звук мотора: ls | v10 | f136 (ENGINE_SOUNDS); по умолчанию большой V8 (Рома 30.10: «берём V8 большой GM LS»)
  mouse: 100, // чувствительность мыши при обзоре, %
  invertY: false, // обратное направление по вертикали при обзоре мышью
  camera: 'chase', // камера при старте: chase | onboard | tcam | nose
  shake: 100, // тряска камеры, %
  feel: 100, // ощущение в кабине: голова пилота от перегрузок, дрожь на поребриках, %
  fov: 100, // поле зрения, % от обычного
  hud: 82, // размер интерфейса, % (0,82 — как подобрано с Ромой 28.10)
  units: 'kmh', // kmh | mph
  minimap: true, // мини-карта
  ghost: true, // призрак лучшего круга в заезде на время и квалификации
  line: 'off', // гоночная линия на асфальте: off | brake (только где тормозить) | full (racingline.js)
  halo: 'fade', // halo из кабины: fade (полупрозрачный) | show | hide — Рома 31.10: «палка перед глазами закрывает поворот»
}

let data = { ...DEFAULTS }
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
  // берём только известные ключи того же типа: старые или битые значения не ломают игру
  for (const k of Object.keys(DEFAULTS)) if (typeof saved[k] === typeof DEFAULTS[k]) data[k] = saved[k]
  if (!QUALITY[data.quality]) data.quality = DEFAULTS.quality
} catch {
  // нет хранилища или файл повреждён — настройки по умолчанию
}

const listeners = new Set()
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // не сохранилось — в этой сессии настройки всё равно действуют
  }
}

export const settings = {
  get: (k) => data[k],
  all: () => ({ ...data }),
  set(k, v) {
    if (!(k in DEFAULTS) || data[k] === v) return
    data[k] = v
    save()
    for (const fn of listeners) fn(k, v)
  },
  reset() {
    data = { ...DEFAULTS }
    save()
    for (const fn of listeners) for (const k of Object.keys(DEFAULTS)) fn(k, data[k])
  },
  // fn(ключ, значение); возвращает функцию отписки
  onChange(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
