import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { activeConversation, insertConversation, migrateConversations } from './conversations'
export {getConversations} from './conversations'
import { ChatError, MAX_REPLY_LENGTH, streamReply, type ModelMessage } from './model'

type DB = Database.Database
type Status = 'running' | 'awaiting' | 'complete' | 'interrupted' | 'failed'
export type ChatTurn = {
  id: string; clientMessageId: string; userText: string; assistantText: string; status: Status;
  mode: 'voice' | 'text'; createdAt: number; timeZone: string; cursor: number
}

export interface ChatHooks {
  context?(db: DB, companionId: string, userText: string): string
  transform?(db: DB, companionId: string, turnId: string, source: AsyncIterable<string>): AsyncIterable<string>
  onDelivered?(db: DB, companionId: string, turnId: string): void
  onDelete?(db: DB, companionId: string, conversationId: string): void
}
interface Generation { id: string; controller: AbortController; generated: string; offset: number; finished: boolean }
export interface Writer { readonly signal: AbortSignal; release(): void }
type Lease = { writer: Writer; conversationId: string; current?: Generation }
const states = new WeakMap<DB, { writers: Map<string, Lease>; hooks: ChatHooks }>()
const columns = 'rowid AS cursor,id,request_id AS clientMessageId,user_text AS userText,delivered_text AS assistantText,mode,status,created_at AS createdAt,time_zone AS timeZone'

export function initChat(db: DB) {
  if (states.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
      client_message_id TEXT NOT NULL, user_text TEXT NOT NULL, delivered_text TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, time_zone TEXT NOT NULL,
      UNIQUE(companion_id,client_message_id)
    );
    CREATE INDEX IF NOT EXISTS chat_turns_by_companion ON chat_turns(companion_id);
    UPDATE chat_turns SET status='interrupted' WHERE status IN ('running','awaiting');
  `)
  migrateConversations(db)
  states.set(db,{writers:new Map(),hooks:{}})
}
function state(db: DB) { initChat(db); return states.get(db)! }
export function configureChat(db: DB, hooks: ChatHooks) { Object.assign(state(db).hooks,hooks) }

function companion(db: DB, id: string) {
  const row = db.prepare('SELECT name,persona,locale FROM companions WHERE id=?').get(id) as {name:string;persona:string;locale:string} | undefined
  if (!row) throw new ChatError('missing')
  return row
}

export function getHistory(db: DB, id: string, before = Number.MAX_SAFE_INTEGER, limit = 40, expected?: string) {
  const conversationId=activeConversation(db,id,expected)
  const rows = db.prepare(`SELECT ${columns} FROM chat_turns WHERE companion_id=? AND conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(id,conversationId,before,limit+1) as ChatTurn[]
  const more = rows.length > limit
  if (more) rows.pop()
  rows.reverse()
  return { conversationId, turns: rows, nextCursor: more ? rows[0].cursor : null }
}
export function findTurn(db: DB, id: string, clientId: string, expected?:string) {
  const conversationId=activeConversation(db,id,expected)
  return db.prepare(`SELECT ${columns} FROM chat_turns WHERE companion_id=? AND conversation_id=? AND request_id=?`).get(id,conversationId,clientId) as ChatTurn | undefined
}
export function acquireWriter(db: DB, id: string, expected?:string): Writer {
  const conversationId=activeConversation(db,id,expected)
  const writers = state(db).writers
  if (writers.has(id)) throw new ChatError('busy')
  const controller = new AbortController()
  const writer: Writer = {
    signal: controller.signal,
    release() {
      const lease = writers.get(id)
      if (lease?.writer !== writer) return
      if (lease.current) interruptTurn(db,id,lease.current.id,writer)
      writers.delete(id)
      controller.abort()
    }
  }
  writers.set(id,{writer,conversationId})
  return writer
}
export function cancelWriter(db: DB, id: string) { state(db).writers.get(id)?.writer.release() }

export function createConversation(db:DB,id:string) {
  companion(db,id)
  if (state(db).writers.has(id)) throw new ChatError('busy')
  return db.transaction(()=>{
    db.prepare('UPDATE chat_conversations SET active=0 WHERE companion_id=? AND active=1').run(id)
    return insertConversation(db,id)
  })()
}
export function selectConversation(db:DB,id:string,conversationId:string) {
  const target=db.prepare('SELECT active FROM chat_conversations WHERE companion_id=? AND id=?').get(id,conversationId) as {active:number}|undefined
  if (!target) throw new ChatError('missing')
  if (target.active) return
  if (state(db).writers.has(id)) throw new ChatError('busy')
  db.transaction(()=>{
    db.prepare('UPDATE chat_conversations SET active=0 WHERE companion_id=? AND active=1').run(id)
    db.prepare('UPDATE chat_conversations SET active=1 WHERE id=?').run(conversationId)
  })()
}
export function deleteConversation(db:DB,id:string,conversationId:string) {
  const target=db.prepare('SELECT active FROM chat_conversations WHERE companion_id=? AND id=?').get(id,conversationId) as {active:number}|undefined
  if (!target) throw new ChatError('missing')
  if (state(db).writers.get(id)?.conversationId===conversationId) cancelWriter(db,id)
  db.transaction(()=>{
    state(db).hooks.onDelete?.(db,id,conversationId)
    db.prepare('DELETE FROM chat_conversations WHERE id=? AND companion_id=?').run(conversationId,id)
    if (target.active) {
      const fallback=db.prepare('SELECT id FROM chat_conversations WHERE companion_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id) as {id:string}|undefined
      if (fallback) db.prepare('UPDATE chat_conversations SET active=1 WHERE id=?').run(fallback.id)
    }
  })()
}
export function clearConversation(db:DB,id:string) { deleteConversation(db,id,activeConversation(db,id)) }
export function interruptTurn(db: DB, id: string, turnId: string, writer: Writer) {
  const lease = state(db).writers.get(id)
  const generation = lease?.current
  if (!lease || lease.writer !== writer || !generation || generation.id !== turnId) return false
  lease.current = undefined
  db.prepare("UPDATE chat_turns SET status='interrupted' WHERE companion_id=? AND id=? AND status IN ('running','awaiting')").run(id,turnId)
  generation.controller.abort()
  return true
}
export function ackTurn(db: DB, id: string, turnId: string, endOffset: number, writer: Writer) {
  const lease = state(db).writers.get(id)
  const g = lease?.current
  if (lease?.writer !== writer || !g || g.id !== turnId || !Number.isSafeInteger(endOffset) || endOffset < g.offset || endOffset > g.generated.length) return false
  if (endOffset === g.offset) return true
  if (/[\uD800-\uDBFF]/.test(g.generated.charAt(endOffset - 1))) return false
  const complete = g.finished && endOffset === g.generated.length
  const changed = db.transaction(() => {
    const result = db.prepare("UPDATE chat_turns SET delivered_text=?,status=CASE WHEN ? THEN 'complete' ELSE status END WHERE id=? AND companion_id=? AND status IN ('running','awaiting')").run(g.generated.slice(0,endOffset),Number(complete),turnId,id)
    if (result.changes && g.offset === 0) state(db).hooks.onDelivered?.(db,id,turnId)
    return Boolean(result.changes)
  })()
  if (changed) g.offset = endOffset
  return changed
}

function messages(db: DB, id: string, profile: ReturnType<typeof companion>, turn: ChatTurn): ModelMessage[] {
  const notes = state(db).hooks.context?.(db,id,turn.userText) ?? ''
  const prompt = [
    `You are ${profile.name}, a digital companion. Speak in ${profile.locale}. Your personality: ${profile.persona}`,
    'Follow the topic and tone of the person speaking. You can be brief, listen, ask questions and disagree respectfully. Do not claim to remember things you have not been told.',
    turn.mode === 'voice' ? 'Use short, naturally spoken sentences.' : '',
    notes
  ].filter(Boolean).join('\n')
  let remaining = 24_000 - Buffer.byteLength(prompt + turn.userText)
  const pairs: ModelMessage[][] = []
  for (const previous of getHistory(db,id,turn.cursor,48).turns.reverse()) {
    const cost = Buffer.byteLength(previous.userText + previous.assistantText) + 16
    if (cost > remaining) break
    remaining -= cost
    const pair: ModelMessage[] = [{role:'user',content:previous.userText}]
    if (previous.assistantText) pair.push({role:'assistant',content:previous.assistantText})
    pairs.push(pair)
  }
  return [{role:'system',content:prompt},...pairs.reverse().flat(),{role:'user',content:turn.userText}]
}

export type ReplyOptions = {
  writer?: Writer; conversationId?:string; mode?: 'text' | 'voice'; timeZone?: string; retry?: boolean; onStart?:(turn:ChatTurn)=>void
}
export async function runReply(db: DB, id: string, userText: string, clientId: string, signal: AbortSignal,
  onDelta:(delta:string,turnId:string)=>void|Promise<void>, options: ReplyOptions = {}): Promise<ChatTurn> {
  if (typeof userText !== 'string' || !userText.trim() || userText.length > 4000 || typeof clientId !== 'string' || !/^[\w.:-]{1,128}$/.test(clientId)) throw new ChatError('invalid_message')
  const timeZone = options.timeZone || 'UTC'
  try { new Intl.DateTimeFormat('en',{timeZone}) } catch { throw new ChatError('invalid_timezone') }
  const profile = companion(db,id)
  const conversationId=activeConversation(db,id,options.conversationId)
  const existing = findTurn(db,id,clientId,conversationId)
  if (existing && existing.userText !== userText.trim()) throw new ChatError('id_conflict')
  if (existing && !options.retry) return existing
  if (options.retry && (!existing || existing.status !== 'failed' || existing.assistantText || getHistory(db,id,undefined,1).turns[0]?.id !== existing.id)) throw new ChatError('retry_unavailable')
  if (signal.aborted) throw new ChatError('interrupted')
  const writer = options.writer ?? acquireWriter(db,id,conversationId)
  const lease = state(db).writers.get(id)
  if (lease?.writer !== writer || lease.conversationId!==conversationId) throw new ChatError('interrupted')
  if (lease.current) {
    const prior = lease.current
    if (!prior.finished || prior.offset !== prior.generated.length) throw new ChatError('busy')
    lease.current = undefined
  }
  const turnId = existing?.id ?? randomUUID()
  const g: Generation = {id:turnId,controller:new AbortController(),generated:'',offset:0,finished:false}
  lease.current = g
  const abort = AbortSignal.any([signal,writer.signal,g.controller.signal])
  const assertCurrent = () => {
    if (abort.aborted || lease.current !== g) throw new ChatError('interrupted')
  }
  try {
    if (existing) db.prepare("UPDATE chat_turns SET status='running' WHERE id=?").run(turnId)
    // Use a unique internal value for the original per-companion constraint; request_id is scoped to the thread.
    else db.prepare("INSERT INTO chat_turns(id,companion_id,conversation_id,client_message_id,request_id,user_text,mode,status,created_at,time_zone) VALUES (?,?,?,?,?,?,?,'running',?,?)").run(turnId,id,conversationId,turnId,clientId,userText.trim(),options.mode ?? 'text',Date.now(),timeZone)
    const turn = findTurn(db,id,clientId)!
    options.onStart?.(turn)
    const source = streamReply(messages(db,id,profile,turn),abort)
    const output = state(db).hooks.transform?.(db,id,turnId,source) ?? source
    for await (const chunk of output) {
      assertCurrent()
      if (!chunk) continue
      if (g.generated.length + chunk.length > MAX_REPLY_LENGTH) throw new ChatError('reply_limit')
      g.generated += chunk
      await onDelta(chunk,turnId)
    }
    assertCurrent()
    if (!g.generated.length) throw new ChatError('model_unavailable')
    g.finished = true
    db.prepare('UPDATE chat_turns SET status=? WHERE id=?').run(g.offset === g.generated.length ? 'complete' : 'awaiting',turnId)
    return findTurn(db,id,clientId)!
  } catch (error) {
    const interrupted = abort.aborted || lease.current !== g
    if (lease.current === g) {
      db.prepare('UPDATE chat_turns SET status=? WHERE id=?').run(interrupted ? 'interrupted' : 'failed',turnId)
      lease.current = undefined
      g.controller.abort()
    }
    if (interrupted) throw new ChatError('interrupted')
    throw error instanceof ChatError ? error : new ChatError('model_unavailable')
  } finally {
    if (!options.writer) writer.release()
  }
}
