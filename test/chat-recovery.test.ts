import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ackTurn, acquireWriter, cancelWriter, clearConversation, getHistory, initChat, interruptTurn, runReply } from '../src/server/chat/turns'
import { streamReply } from '../src/server/chat/model'

describe('conversation delivery', () => {
  let db: Database.Database
  const contexts: string[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    contexts.push(body)
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    res.writeHead(200, {'content-type':'text/event-stream'})
    for (const content of ['Hello ', '你好']) {
      const bytes = Buffer.from('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\r\n\r\n')
      res.write(bytes.subarray(0, -7))
      res.write(bytes.subarray(-7))
    }
    res.end('data: [DONE]\r\n\r\n')
  })
  beforeEach(async () => {
    db = new Database(':memory:')
    db.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,name TEXT,persona TEXT,locale TEXT,voice TEXT); INSERT INTO companions VALUES ('a','Aya','Warm','en-US',''),('b','Rin','Serious','zh-CN','')")
    initChat(db)
    contexts.length = 0
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    vi.stubEnv('DUET_MODEL_BASE_URL', 'http://127.0.0.1:'+ (server.address() as AddressInfo).port + '/v1')
    vi.stubEnv('DUET_MODEL_NAME', 'fixture')
  })
  afterEach(async () => {
    cancelWriter(db,'a'); cancelWriter(db,'b'); db.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })
  it('deduplicates a retried network message and retains only displayed text for subsequent prompts', async () => {
    const writer = acquireWriter(db,'a')
    const turn = await runReply(db,'a','My presentation','uuid-1',writer.signal,(delta,id) => {
      if (delta === 'Hello ') expect(ackTurn(db,'a',id,6,writer)).toBe(true)
    },{writer,timeZone:'Asia/Shanghai'})
    expect(turn.assistantText).toBe('Hello ')
    writer.release()
    await runReply(db,'a','My presentation','uuid-1',new AbortController().signal,()=>{})
    expect(contexts).toHaveLength(1)
    await runReply(db,'a','Go on','uuid-2',new AbortController().signal,()=>{})
    expect(contexts[1]).toContain('Hello ')
    expect(contexts[1]).not.toContain('你好')
    expect(getHistory(db,'a').turns[0]).toMatchObject({timeZone:'Asia/Shanghai',status:'interrupted'})
    await runReply(db,'b','Who are you?','uuid-1',new AbortController().signal,()=>{})
    expect(contexts[2]).not.toContain('presentation')
    expect(getHistory(db,'b').turns).toHaveLength(1)
  })
  it('holds one writer, rejects fabricated ACKs and fences cancelled callbacks', async () => {
    const writer = acquireWriter(db,'a')
    expect(()=>acquireWriter(db,'a')).toThrow(/busy/)
    let id = ''
    await expect(runReply(db,'a','First','uuid-3',writer.signal,(delta, turnId) => {
      id = turnId
      expect(ackTurn(db,'a',id,999,writer)).toBe(false)
      interruptTurn(db,'a',id,writer)
    },{writer})).rejects.toMatchObject({code:'interrupted'})
    expect(ackTurn(db,'a',id,1,writer)).toBe(false)
    clearConversation(db,'a')
    expect(writer.signal.aborted).toBe(true)
    expect(getHistory(db,'a').turns).toHaveLength(0)
  })
  it('preserves failed input and only regenerates upon explicit retry', async () => {
    vi.stubEnv('DUET_MODEL_NAME','')
    const signal = new AbortController().signal
    await expect(runReply(db,'a','Is anyone here?','fail',signal,()=>{})).rejects.toMatchObject({code:'model_unconfigured'})
    expect(getHistory(db,'a').turns[0].status).toBe('failed')
    vi.stubEnv('DUET_MODEL_NAME','fixture')
    await runReply(db,'a','Is anyone here?','fail',signal,()=>{})
    expect(contexts).toHaveLength(0)
    await runReply(db,'a','Is anyone here?','fail',signal,()=>{}, {retry:true})
    expect(contexts).toHaveLength(1)
    expect(getHistory(db,'a').turns).toHaveLength(1)
  })
  it('recovers an unfinished disk-backed turn after a restart and preserves history order across pages', async () => {
    const directory = mkdtempSync(join(tmpdir(),'duet-chat-'))
    const file = join(directory,'chat.db')
    let store = new Database(file)
    try {
      store.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,name TEXT,persona TEXT,locale TEXT,voice TEXT); INSERT INTO companions VALUES('a','Aya','','en-US','')")
      initChat(store)
      const writer = acquireWriter(store,'a')
      await runReply(store,'a','First','first',writer.signal,(delta,id)=>{
        if (delta==='Hello ') ackTurn(store,'a',id,6,writer)
      },{writer})
      store.close()
      store = new Database(file)
      initChat(store)
      expect(getHistory(store,'a').turns[0]).toMatchObject({assistantText:'Hello ',status:'interrupted'})
      await runReply(store,'a','Second','second',new AbortController().signal,()=>{})
      const page = getHistory(store,'a',undefined,1)
      expect(page.turns.map(row=>row.userText)).toEqual(['Second'])
      expect(getHistory(store,'a',page.nextCursor!,1).turns.map(row=>row.userText)).toEqual(['First'])
    } finally { if(store.open)store.close();rmSync(directory,{recursive:true,force:true}) }
  })
  it('fails truncated compatible streams instead of reporting success', async () => {
    vi.stubGlobal('fetch',async()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
    try {
      const read = async () => {for await(const _ of streamReply([{role:'user',content:'hi'}],new AbortController().signal)){}}
      await expect(read()).rejects.toMatchObject({code:'model_unavailable'})
    } finally {vi.unstubAllGlobals()}
  })
})
