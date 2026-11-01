/** github.com's counters: one decimal below 100k ("17.5k"), whole thousands above ("124k"), "M" for millions. */
export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0'
  if (n < 1000) return String(n)
  if (n < 99_950) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n < 999_500) return Math.round(n / 1000) + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 2 : 1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ${s % 60}s`
}

export function durationBetween(start?: string | null, end?: string | null): string {
  if (!start) return ''
  const a = new Date(start).getTime()
  const b = end ? new Date(end).getTime() : Date.now()
  return formatDuration(b - a)
}

export function plural(n: number, word: string, pluralWord = word + 's') {
  return `${n.toLocaleString()} ${n === 1 ? word : pluralWord}`
}

export function shortSha(sha: string) {
  return sha.slice(0, 7)
}

export function firstLine(message: string) {
  const i = message.indexOf('\n')
  return i === -1 ? message : message.slice(0, i)
}

export function restLines(message: string) {
  const i = message.indexOf('\n')
  return i === -1 ? '' : message.slice(i + 1).trim()
}

export function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
