import type { Octokit } from '@octokit/rest'
import type { Account } from './auth'
import { native } from './platform'

// GET .../actions/jobs/{id}/logs answers with a 302 to a short-lived blob URL.
// Browsers may refuse that cross-origin hop, so fall back to the desktop main
// process or to the Worker (/api/gh/job-logs), both of which follow the redirect
// without forwarding the GitHub token to the blob host.

export async function fetchJobLogs(octokit: Octokit, account: Account, owner: string, repo: string, jobId: number): Promise<string> {
  if (native) {
    const res = await native.http({
      url: `${account.apiBase}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      headers: { Authorization: `Bearer ${account.token}`, Accept: 'application/vnd.github+json' },
    })
    if (res.status >= 400) throw Object.assign(new Error(logError(res.status)), { status: res.status })
    return res.body
  }
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { owner, repo, job_id: jobId })
    return typeof res.data === 'string' ? res.data : String(res.data)
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status && status !== 500) throw Object.assign(new Error(logError(status)), { status })
  }
  const res = await fetch(`/api/gh/job-logs?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&job=${jobId}&api=${encodeURIComponent(account.apiBase)}`, {
    headers: { Authorization: `Bearer ${account.token}` },
  })
  if (!res.ok) throw Object.assign(new Error(logError(res.status)), { status: res.status })
  return res.text()
}

function logError(status: number) {
  if (status === 404 || status === 410) return 'Logs are not available. They may have expired or the job has not started.'
  if (status === 403) return 'Your token cannot read Actions logs for this repository (needs repo / actions:read).'
  return `Could not load logs (HTTP ${status}).`
}

export interface LogLine {
  n: number
  time: string | null
  text: string
  kind: 'normal' | 'error' | 'warning' | 'command' | 'group' | 'endgroup' | 'notice' | 'debug'
  /** Set for GitHub's own ##[error] annotations, as opposed to lines that merely look like errors. */
  annotated?: boolean
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?/
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g

export function parseLog(raw: string): LogLine[] {
  const out: LogLine[] = []
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let n = 0
  for (const line of lines) {
    if (!line && n === lines.length - 1) continue
    const m = line.match(TS_RE)
    const time = m ? m[1] : null
    let text = (m ? line.slice(m[0].length) : line).replace(ANSI_RE, '').replace(/^﻿/, '')
    let annotated = false
    let kind: LogLine['kind'] = 'normal'
    if (text.startsWith('##[group]')) {
      kind = 'group'
      text = text.slice(9)
    } else if (text.startsWith('##[endgroup]')) {
      kind = 'endgroup'
      text = ''
    } else if (text.startsWith('##[error]')) {
      kind = 'error'
      annotated = true
      text = text.slice(9)
    } else if (text.startsWith('##[warning]')) {
      kind = 'warning'
      text = text.slice(11)
    } else if (text.startsWith('##[notice]')) {
      kind = 'notice'
      text = text.slice(10)
    } else if (text.startsWith('##[debug]')) {
      kind = 'debug'
      text = text.slice(9)
    } else if (text.startsWith('[command]')) {
      kind = 'command'
      text = text.slice(9)
    } else if (/^(Error|ERROR|FAIL|✖|×)\b/.test(text) || /\berror( TS\d+)?:/.test(text)) {
      kind = 'error'
    }
    out.push({ n: ++n, time, text, kind, ...(annotated ? { annotated } : {}) })
  }
  return out
}

/** Error-ish excerpt for the agent: every error line with a little surrounding context, plus the tail. */
export function summarizeLog(raw: string, opts: { tail?: number; grep?: string } = {}): string {
  const lines = parseLog(raw)
  const tail = opts.tail ?? 150
  const pick = new Set<number>()
  const re = opts.grep ? safeRegex(opts.grep) : null
  lines.forEach((l, i) => {
    if (l.kind === 'error' || (re && re.test(l.text))) {
      for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 5); j++) pick.add(j)
    }
  })
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) pick.add(i)
  const sorted = [...pick].sort((a, b) => a - b)
  const out: string[] = []
  let prev = -2
  for (const i of sorted) {
    if (i !== prev + 1) out.push('…')
    const l = lines[i]
    out.push(`${l.n}: ${l.kind === 'group' ? '▸ ' : ''}${l.text}`)
    prev = i
  }
  return `Total lines: ${lines.length}\n` + out.join('\n')
}

function safeRegex(src: string) {
  try {
    return new RegExp(src, 'i')
  } catch {
    return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

export interface StepInput {
  number: number
  name: string
  status: string
  conclusion?: string | null
  started_at?: string | null
  completed_at?: string | null
}

export interface StepLog extends StepInput {
  conclusion: string | null
  lines: LogLine[]
}

const STEP_HEADER = (l: LogLine) => (l.kind === 'group' && l.text.startsWith('Run ')) || l.text === 'Post job cleanup.' || l.text === 'Cleaning up orphan processes'

/**
 * Splits a job log into its steps. GitHub reports step times truncated to the second, and
 * each step's log opens with its header ("##[group]Run …", "Post job cleanup.", "Cleaning up
 * orphan processes") within that first second. So a header starts the next step only once
 * its timestamp reaches both the next step's start and the current step's end: composite
 * actions log their inner steps as "Run …" groups too, but those come before their own step
 * ends. Several short steps often share one second, so each header advances exactly one
 * step. Other lines move on only once they are clearly past the current step.
 * One case stays ambiguous: if a composite action's last inner step starts in the same
 * truncated second the composite ends (and the next step starts), its "Run …" group can land
 * at the top of the next step. The API exposes no finer step boundaries (the run log archive
 * no longer has per-step files), so failed steps are still expanded by their conclusion.
 */
export function splitLogBySteps(steps: StepInput[], lines: LogLine[]): StepLog[] {
  const ms = (iso?: string | null) => (iso ? new Date(iso).getTime() : null)
  const out = steps.map((s) => ({ ...s, conclusion: s.conclusion ?? null, start: ms(s.started_at), end: ms(s.completed_at), lines: [] as LogLine[] }))
  if (!out.length) return []
  // Skipped steps (and steps that never started) have no lines.
  const nextLive = (i: number) => {
    let j = i + 1
    while (j < out.length && (out[j].start === null || out[j].conclusion === 'skipped')) j++
    return j < out.length ? j : -1
  }
  let current = 0
  for (const line of lines) {
    if (line.time) {
      const t = new Date(line.time).getTime()
      let next = nextLive(current)
      if (STEP_HEADER(line)) {
        const end = out[current].end
        if (next !== -1 && t >= out[next].start! && (end === null || t >= end)) current = next
      } else {
        while (next !== -1 && ((out[current].end !== null && t >= out[current].end! + 1000) || t >= out[next].start! + 1000)) {
          current = next
          next = nextLive(current)
        }
      }
    }
    out[current].lines.push(line)
  }
  return out.map(({ start: _start, end: _end, ...s }) => s)
}
