import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type {} from '@fastify/websocket'
import { isSessionValid } from '../auth'
import { ChatError, modelConfigured, streamReply } from './model'
import { ackTurn, acquireWriter, clearConversation, createConversation, deleteConversation, findTurn, getConversations, selectConversation, getHistory, initChat, runReply, type Writer } from './turns'

const base = '/api/companions/:id/chat'
type Params = {id:string}
function routeError(reply: FastifyReply, error:unknown) {
  if (!(error instanceof ChatError)) throw error
  return reply.code(error.code==='missing'?404:409).send({error:error.code})
}

export function registerChat(app: FastifyInstance, db: Database.Database) {
  initChat(db)
  app.get<{Params:Params; Querystring:{before?:string;conversationId?:string}}>(base,async(req,reply) => {
    const cursor = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before)
    if (!Number.isSafeInteger(cursor) || cursor <= 0) return reply.code(400).send({error:'invalid_cursor'})
    try { return {...getHistory(db,req.params.id,cursor,40,req.query.conversationId),conversations:getConversations(db,req.params.id),modelConfigured:modelConfigured()} }
    catch (error) { return routeError(reply,error) }
  })
  app.delete<{Params:Params}>(base,async(req,reply) => {
    try { clearConversation(db,req.params.id); return reply.code(204).send() }
    catch (error) { return routeError(reply,error) }
  })
  app.post<{Params:Params}>(base+'/conversations',async(req,reply)=>{
    try { return reply.code(201).send(createConversation(db,req.params.id)) }
    catch(error) { return routeError(reply,error) }
  })
  app.put<{Params:Params & {thread:string}}>(base+'/conversations/:thread/active',async(req,reply)=>{
    try { selectConversation(db,req.params.id,req.params.thread); return reply.code(204).send() }
    catch(error) { return routeError(reply,error) }
  })
  app.delete<{Params:Params & {thread:string}}>(base+'/conversations/:thread',async(req,reply)=>{
    try { deleteConversation(db,req.params.id,req.params.thread); return reply.code(204).send() }
    catch(error) { return routeError(reply,error) }
  })
  app.post('/api/chat/model/probe',async(_req,reply) => {
    try {
      for await (const delta of streamReply([{role:'user',content:'Reply with OK.'}],AbortSignal.timeout(20_000))) {
        if (delta.trim()) return {available:true}
      }
      throw new ChatError('model_unavailable')
    } catch(error) {
      return reply.code(503).send({error:error instanceof ChatError ? error.code : 'model_unavailable'})
    }
  })
  app.get<{Params:Params}>(base+'/socket',{websocket:true},(socket,req) => {
    const {id} = req.params
    let writer: Writer | undefined
    let turnId = ''
    let generated = 0
    let acknowledged = 0
    let ended = false
    let started = false
    let valid = true
    const openedAt = Date.now()
    let activity = openedAt
    let endedAt = 0
    const controller = new AbortController()
    const send = (message: object) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    const close = (code = 1000) => {
      if (!valid) return
      valid = false
      controller.abort()
      writer?.release()
      socket.close(code)
    }
    const fail = (code: string) => { send({type:'error',code}); close() }
    const checkSession = () => {
      if (!valid) return false
      if (isSessionValid(db,req)) return true
      fail('login_required')
      return false
    }
    const timer = setInterval(() => {
      if (!checkSession()) return
      const now = Date.now()
      if (now-activity > 40_000 || (!started && now-openedAt > 15_000) || (ended && now-endedAt > 30_000) || now-openedAt > 300_000) { fail('connection_lost'); return }
      socket.ping()
    },10_000)
    socket.on('pong',()=>{activity=Date.now()})
    socket.on('error',()=>close())
    socket.on('close',()=>{clearInterval(timer);close()})
    // One connection owns a single generation through its last displayed-prefix acknowledgement.
    socket.on('message',async(data,binary) => {
      if (!checkSession()) return
      activity=Date.now()
      try {
        if (binary || !Buffer.isBuffer(data) || data.byteLength > 32_000) throw new ChatError('invalid_message')
        const msg = JSON.parse(data.toString())
        if (msg.type === 'interrupt') { close(); return }
        if (msg.type === 'text.ack') {
          if (!writer || msg.turnId !== turnId || !ackTurn(db,id,turnId,msg.offset,writer)) throw new ChatError('invalid_ack')
          acknowledged = msg.offset
          if (ended && acknowledged === generated) close()
          return
        }
        if (msg.type !== 'text.send' || started || msg.protocolVersion !== 1) throw new ChatError('invalid_message')
        started = true
        if (typeof msg.clientMessageId !== 'string' || typeof msg.text !== 'string') throw new ChatError('invalid_message')
        if (msg.conversationId !== undefined && (typeof msg.conversationId!=='string' || !msg.conversationId)) throw new ChatError('invalid_message')
        const existing = findTurn(db,id,msg.clientMessageId,msg.conversationId)
        if (existing && !msg.retry) {
          if (existing.userText !== msg.text.trim()) throw new ChatError('id_conflict')
          send({type:'snapshot',turn:existing}); close(); return
        }
        writer = acquireWriter(db,id,msg.conversationId)
        writer.signal.addEventListener('abort',()=>close(),{once:true})
        await runReply(db,id,msg.text,msg.clientMessageId,controller.signal,(delta) => {
          if (!checkSession()) throw new ChatError('interrupted')
          if (socket.bufferedAmount > 256_000) throw new ChatError('connection_lost')
          generated += delta.length
          send({type:'text.delta',turnId,delta})
        },{writer,conversationId:msg.conversationId,timeZone:msg.timeZone,retry:msg.retry === true,onStart(turn) {
          turnId = turn.id
          send({type:'turn.started',turn})
        }})
        ended = true
        endedAt = Date.now()
        send({type:'turn.ended',turnId,offset:generated})
        if (acknowledged === generated) close()
      } catch(error) {
        if (valid) fail(error instanceof ChatError ? error.code : 'invalid_message')
      }
    })
  })
}
