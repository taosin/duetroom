import { createHash } from 'node:crypto'
import { once } from 'node:events'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { registerAuth } from '../src/server/auth'
import { registerChat } from '../src/server/chat/routes'

test('authenticated text socket persists a rendered reply, deduplicates and rejects revoked session ACKs', async () => {
  const db = new Database(':memory:')
  db.exec("CREATE TABLE sessions(digest TEXT PRIMARY KEY,expires_at INTEGER); CREATE TABLE companions(id TEXT PRIMARY KEY,name TEXT,persona TEXT,locale TEXT,voice TEXT); INSERT INTO companions VALUES ('a','Aya','gentle','en-US','')")
  const origin='http://localhost:3000'
  const token='fixture-session'
  const headers={cookie:'duet_session='+token,origin}
  db.prepare('INSERT INTO sessions VALUES(?,?)').run(createHash('sha256').update(token).digest('hex'), Date.now()+60000)
  const app = Fastify()
  app.register(cookie)
  app.register(websocket)
  app.register(async child=>{
    registerAuth(child,db,origin)
    registerChat(child,db)
  })
  vi.stubEnv('DUET_MODEL_BASE_URL','http://model.invalid/v1')
  vi.stubEnv('DUET_MODEL_NAME','test')
  const model=vi.fn(async()=>new Response('data: {"choices":[{"delta":{"content":"Hi!"}}]}\n\ndata: [DONE]\n\n'))
  vi.stubGlobal('fetch',model)
  const url='/api/companions/a/chat'
  const request={type:'text.send',protocolVersion:1,text:'Hi',clientMessageId:'hello'}
  try {
    await app.ready()
    expect((await app.inject({url})).statusCode).toBe(401)
    await expect(app.injectWS(url+'/socket',{headers:{...headers,origin:'http://evil.invalid'}})).rejects.toThrow()
    const ws=await app.injectWS(url+'/socket',{headers})
    const closed=once(ws,'close')
    const output:string[]=[]
    ws.on('message',data=>{
      const msg=JSON.parse(data.toString())
      if (msg.type==='text.delta') {
        output.push(msg.delta)
        ws.send(JSON.stringify({type:'text.ack',turnId:msg.turnId,offset:msg.delta.length}))
      }
    })
    ws.send(JSON.stringify(request))
    await closed
    expect(output).toEqual(['Hi!'])
    const snapshot=(await app.inject({url,headers})).json()
    expect(snapshot.turns[0]).toMatchObject({assistantText:'Hi!',status:'complete'})
    const duplicate=await app.injectWS(url+'/socket',{headers})
    const received=once(duplicate,'message')
    duplicate.send(JSON.stringify(request))
    expect(JSON.parse(String((await received)[0])).type).toBe('snapshot')
    expect(model).toHaveBeenCalledTimes(1)
    const revoked=await app.injectWS(url+'/socket',{headers})
    const denied=once(revoked,'message')
    db.exec('DELETE FROM sessions')
    revoked.send(JSON.stringify({...request,clientMessageId:'next'}))
    expect(JSON.parse(String((await denied)[0])).code).toBe('login_required')
  } finally {await app.close();db.close();vi.unstubAllGlobals();vi.unstubAllEnvs()}
})
