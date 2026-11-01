import type { Account } from '../auth'
import { createClient, describeAgentError, FALLBACK_MODELS } from './runner'
import { getAnthropicKey, loadAgentSettings, proxyBaseUrl } from './settings'

const MAX_DIFF_CHARS = 120_000

/** Writes a commit message for a staged diff (local repositories). */
export async function generateCommitMessage(diff: string, account: Account): Promise<{ summary: string; description: string }> {
  const settings = loadAgentSettings()
  const client = createClient(settings, settings.mode === 'direct' ? await getAnthropicKey() : null, proxyBaseUrl(settings), account)
  const truncated = diff.length > MAX_DIFF_CHARS
  const body = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff
  try {
    const res = await client.beta.messages.create({
      model: settings.model,
      max_tokens: 2000,
      ...(FALLBACK_MODELS.has(settings.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Imperative subject line, at most 72 characters.' },
              description: { type: 'string', description: 'Optional body explaining what and why; empty string if the subject says it all.' },
            },
            required: ['summary', 'description'],
            additionalProperties: false,
          },
        },
      },
      system:
        'You write git commit messages. Follow the repository conventions visible in the diff when obvious (e.g. Conventional Commits). Describe what changed and why, not how. No marketing language.',
      messages: [
        {
          role: 'user',
          content: `Write a commit message for this staged diff${truncated ? ` (the diff was ${diff.length.toLocaleString()} characters; only the first ${MAX_DIFF_CHARS.toLocaleString()} are included)` : ''}:\n\n<diff>\n${body}\n</diff>`,
        },
      ],
    })
    if (res.stop_reason === 'refusal') throw new Error('The model declined this request.')
    const text = res.content.find((b) => b.type === 'text')
    if (!text || text.type !== 'text') throw new Error('No message returned.')
    const parsed = JSON.parse(text.text) as { summary: string; description: string }
    return { summary: parsed.summary.trim(), description: parsed.description.trim() }
  } catch (err) {
    throw new Error(describeAgentError(err))
  }
}
