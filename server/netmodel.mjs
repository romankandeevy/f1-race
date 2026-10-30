// Модель канала для проверок без tc/netem (macOS): WebSocket идёт по TCP, поэтому потеря пакета — не дыра,
// а задержка на переотправку (RTO) и остановка всех следующих сообщений. Порядок сохраняется.
// cfg: { delay мс в одну сторону, jitter ± мс, loss доля пакетов с потерей, rto мс }
export function makeLink({ delay = 0, jitter = 0, loss = 0, rto = 250 }, rng = Math.random) {
  let lastDue = -Infinity
  return {
    // момент доставки пакета, отправленного в now (мс); возвращает due
    schedule(now) {
      let due = now + delay + (jitter ? (rng() * 2 - 1) * jitter : 0)
      if (rng() < loss) due += rto
      due = Math.max(due, lastDue)
      lastDue = due
      return due
    },
  }
}
