import { readPref, writePref, secrets } from '../storage'
import { isNative } from '../platform'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentSettings {
  /** direct: the browser/app calls api.anthropic.com with your key. proxy: a gh-ui Worker holds the key. */
  mode: 'direct' | 'proxy'
  /** Worker origin for proxy mode. Empty = same origin (Cloudflare deploy). Required in the desktop app. */
  proxyUrl: string
  model: string
  effort: Effort
  /** Run write tools (comments, commits, re-runs) without asking each time. */
  autoApproveWrites: boolean
  customInstructions: string
}

export const MODELS: Array<{ id: string; label: string; note: string }> = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Default. Best balance for reviews and fixes.' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster and cheaper for everyday triage.' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest. Good for quick questions.' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'Most capable; slower and pricier.' },
]

export const DEFAULT_SETTINGS: AgentSettings = {
  mode: 'direct',
  proxyUrl: '',
  model: 'claude-opus-5-5',
  effort: 'high',
  autoApproveWrites: false,
  customInstructions: '',
}

export function loadAgentSettings(): AgentSettings {
  const saved = { ...DEFAULT_SETTINGS, ...readPref<Partial<AgentSettings>>('agentSettings', {}) }
  // The desktop app runs everything on this machine: no Worker in between.
  return isNative ? { ...saved, mode: 'direct' } : saved
}

export function saveAgentSettings(s: AgentSettings) {
  writePref('agentSettings', s)
}

export const ANTHROPIC_KEY_SECRET = 'anthropic-api-key'

export async function getAnthropicKey() {
  return secrets.get(ANTHROPIC_KEY_SECRET)
}

export async function setAnthropicKey(key: string | null) {
  if (key) await secrets.set(ANTHROPIC_KEY_SECRET, key.trim())
  else await secrets.delete(ANTHROPIC_KEY_SECRET)
}

export function proxyBaseUrl(s: AgentSettings): string | null {
  const base = s.proxyUrl.trim().replace(/\/$/, '')
  if (base) return `${base}/api/anthropic`
  if (isNative) return null
  return `${window.location.origin}/api/anthropic`
}
