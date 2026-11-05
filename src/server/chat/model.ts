import { readFileSync } from 'node:fs'

export class ChatError extends Error {
  constructor(public readonly code: string) { super(code) }
}

export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export const MAX_REPLY_LENGTH = 24_000

function endpoint(): URL | undefined {
  try {
    const base = process.env.DUET_MODEL_BASE_URL?.trim().replace(/\/+$/, '')
    if (!base || !process.env.DUET_MODEL_NAME?.trim()) return
    const url = new URL(base + '/chat/completions')
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url
  } catch { /* An incomplete deployment can still use the settings and history. */ }
}

export function modelConfigured() { return Boolean(endpoint()) }

export async function* streamReply(messages: ModelMessage[], signal: AbortSignal): AsyncGenerator<string> {
  const url = endpoint()
  if (!url) throw new ChatError('model_unconfigured')
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const timeout = new AbortController()
  const deadline = AbortSignal.any([signal, timeout.signal])
  // Exclude time spent playing a voice segment while the consumer holds a yielded delta.
  const waiting = async <T>(operation: Promise<T>) => {
    const timer = setTimeout(() => timeout.abort(), 90_000)
    try { return await operation } finally { clearTimeout(timer) }
  }
  try {
    const keyFile = process.env.DUET_MODEL_API_KEY_FILE
    const key = keyFile ? readFileSync(keyFile, 'utf8').trim() : process.env.DUET_MODEL_API_KEY
    const response = await waiting(fetch(url, {
      method: 'POST', signal: deadline, redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model: process.env.DUET_MODEL_NAME?.trim(), messages, stream: true, max_tokens: 1024 })
    }))
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new ChatError('model_unavailable') }
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let total = 0
    let finishReason = false
    for (;;) {
      const {done, value} = await waiting(reader.read())
      pending += decoder.decode(value, {stream: !done})
      // An SSE event ends with an empty line. Keep the tail across UTF-8 and network chunk boundaries.
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, boundary.index)
        pending = pending.slice(boundary.index + boundary[0].length)
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        if (data.trim() === '[DONE]') {
          if (!total) throw new ChatError('model_unavailable')
          return
        }
        const event = JSON.parse(data)
        if (event.error || !Array.isArray(event.choices)) throw new ChatError('model_unavailable')
        const choice = event.choices[0]
        if (choice?.finish_reason) finishReason = true
        const delta = choice?.delta?.content
        if (typeof delta === 'string' && delta.length) {
          total += delta.length
          if (total > MAX_REPLY_LENGTH) throw new ChatError('reply_limit')
          yield delta
        }
      }
      if (pending.length > 131_072) throw new ChatError('reply_limit')
      if (done) {
        if (finishReason && total && !pending.trim()) return
        throw new ChatError('model_unavailable')
      }
    }
  } catch (error) {
    if (signal.aborted) throw new ChatError('interrupted')
    throw error instanceof ChatError ? error : new ChatError('model_unavailable')
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}
