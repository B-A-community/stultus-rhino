/**
 * Версии. Gateway и окно (ui/) живут вместе и обновляются вместе; хост в
 * Rhino (C#) обновляется редко, и gateway говорит окну, какой хост минимально
 * нужен: старее — окно предлагает обновить плагин.
 */
export const VERSION = '0.1.0'

/** Минимальная версия хоста Rhino, с которой работает это окно и эти скрипты. */
export const HOST_MIN_VERSION = '0.1.0'

/** Сравнение «a < b» для версий вида 1.2.3. */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}
