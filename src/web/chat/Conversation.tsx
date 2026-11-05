import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import './chat.css'

export type ChatSource = {turnId:string;role:'user'|'assistant';text:string;createdAt:number;timeZone:string}
type Turn = {
  id:string;clientMessageId:string;userText:string;assistantText:string;status:'running'|'awaiting'|'interrupted'|'complete'|'failed';
  mode:'text'|'voice';createdAt:number;timeZone:string
}
type ChatProps = {
  companion:{id:string;name:string;locale:string;persona:string;voice:string};lang:'zh'|'en';
  renderCall?:(controls:{refresh:()=>void;busy:boolean;setCallActive:(active:boolean)=>void})=>ReactNode;
  renderMessageAction?:(source:ChatSource)=>ReactNode
}

const copy = {
  zh:{
    you:'我',history:'聊天记录',empty:'从一句问候开始',first:(name:string)=>'给'+name+'写下第一条消息。',older:'查看更早的消息',
    placeholder:(name:string)=>'给'+name+'写消息…',send:'发送',stop:'停止回复',retry:'重新生成',loading:'正在读取聊天记录…',typing:'正在回复…',
    failed:'回复失败',interrupted:'已中断',missing:'文字模型尚未配置。请在服务端设置 DUET_MODEL_BASE_URL 和 DUET_MODEL_NAME。',
    model:'暂时无法连接文字模型。请检查模型服务，再重试。',busy:'另一个页面或通话正在使用这个角色，请稍后再发。',
    network:'连接已中断。重新连接后可查看已保存的消息。',reload:'重新连接',login:'登录已过期，请刷新页面重新登录。',
    clear:'清除聊天记录',confirm:'清除这段对话及其关联的记忆？',erase:'确认清除',cancel:'取消',voice:'通话',limit:'回复已达到长度上限。',
    invalid:'消息无法发送，请检查内容后重试。',conversation:'对话',check:'检查模型连接',working:'正在检查…',checked:'模型连接成功。',
    more:'对话选项',today:'今天',callActive:'通话中，挂断后可以打字。'
  },
  en:{
    you:'You',history:'Chat history',empty:'Start with a hello',first:(name:string)=>'Write your first message to '+name+'.',older:'Load earlier messages',
    placeholder:(name:string)=>'Message '+name+'…',send:'Send',stop:'Stop reply',retry:'Retry reply',loading:'Loading messages…',typing:'Replying…',
    failed:'Reply failed',interrupted:'Interrupted',missing:'Text model setup required. Set DUET_MODEL_BASE_URL and DUET_MODEL_NAME on the server.',
    model:'Could not reach the text model. Check the model service, then try again.',busy:'This companion is busy in another tab or call. Try again shortly.',
    network:'Connection lost. Reconnect to see your saved messages.',reload:'Reconnect',login:'Your session expired. Reload the page to sign in.',
    clear:'Clear chat history',confirm:'Clear this conversation and its linked memories?',erase:'Clear conversation',cancel:'Cancel',voice:'Call',limit:'The reply reached its length limit.',
    invalid:'Could not send this message. Check the contents and retry.',conversation:'Conversation',check:'Check model connection',working:'Checking…',checked:'Model connected.',
    more:'Conversation options',today:'Today',callActive:'End the call to type a message.'
  }
}
function Arrow({stop=false}:{stop?:boolean}) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">{stop
    ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
    : <path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>}</svg>
}
function Chat({companion,lang,renderCall,renderMessageAction}: ChatProps) {
  const t=copy[lang]
  const path='/api/companions/'+encodeURIComponent(companion.id)+'/chat'
  const [turns,setTurns]=useState<Turn[]>([])
  const [cursor,setCursor]=useState<number|null>(null)
  const [loaded,setLoaded]=useState(false)
  const [configured,setConfigured]=useState<boolean|null>(null)
  const [error,setError]=useState('')
  const [draft,setDraft]=useState('')
  const [busy,setBusy]=useState(false)
  const [callActive,setCallActive]=useState(false)
  const [activeId,setActiveId]=useState('')
  const [menu,setMenu]=useState(false)
  const [confirm,setConfirm]=useState(false)
  const [probing,setProbing]=useState(false)
  const [probed,setProbed]=useState(false)
  const socket=useRef<WebSocket|null>(null)
  const alive=useRef(true)
  const historyVersion=useRef(0)
  const view=useRef<HTMLDivElement>(null)
  const follow=useRef(true)
  const anchorHeight=useRef<number|null>(null)
  const pendingMore=useRef(false)
  const input=useRef<HTMLTextAreaElement>(null)
  const reusable=useRef<{id:string;text:string}|null>(null)
  const refresh=useCallback(async(before?:number)=>{
    if (before && pendingMore.current) return
    if (before) pendingMore.current=true
    const revision=++historyVersion.current
    try {
      const r=await fetch(path+(before?'?before='+before:''))
      if (!r.ok) throw Error(r.status===401?'login_required':'connection_lost')
      const data=await r.json()
      if (!alive.current || revision!==historyVersion.current || socket.current) return
      if (before) anchorHeight.current=view.current?.scrollHeight ?? null
      setTurns(prev=>before?[...data.turns,...prev]:data.turns)
      setCursor(data.nextCursor);setConfigured(data.modelConfigured);setLoaded(true)
      setError(prev=>prev==='connection_lost'?'':prev)
    } catch(e) {
      if (alive.current && revision===historyVersion.current) setError(e instanceof Error && e.message==='login_required'?'login_required':'connection_lost')
    } finally { if (before) pendingMore.current=false }
  },[path])
  useEffect(()=>{
    alive.current=true
    void refresh()
    const restore=()=>{if (!socket.current && !document.hidden) void refresh()}
    const visibility=()=>{ if(document.hidden) socket.current?.close(); else restore() }
    window.addEventListener('online',restore)
    window.addEventListener('focus',restore)
    document.addEventListener('visibilitychange',visibility)
    return ()=>{
      alive.current=false;historyVersion.current++
      const current=socket.current;socket.current=null;current?.close()
      window.removeEventListener('online',restore);window.removeEventListener('focus',restore)
      document.removeEventListener('visibilitychange',visibility)
    }
  },[refresh])
  useLayoutEffect(()=>{
    const el=view.current
    if (!el) return
    if (anchorHeight.current!==null) {el.scrollTop+=el.scrollHeight-anchorHeight.current;anchorHeight.current=null}
    else if (follow.current) el.scrollTop=el.scrollHeight
  },[turns,activeId])

  const active=turns.find(row=>row.id===activeId)
  const rendered=active?.assistantText.length ?? 0
  useEffect(()=>{
    if (!rendered || !activeId || document.hidden) return
    const current=socket.current
    // Acknowledge after the browser has had a paint opportunity for this committed prefix.
    // Do not cancel an older committed prefix simply because a newer delta arrived.
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if (!document.hidden && current && current===socket.current && current.readyState===WebSocket.OPEN)
        current.send(JSON.stringify({type:'text.ack',turnId:activeId,offset:rendered}))
    }))
  },[activeId,rendered])

  function send(text:string,clientMessageId:string,retry=false) {
    if (socket.current || callActive || !text.trim()) return
    setError('');setBusy(true);setMenu(false);follow.current=true
    let ws:WebSocket
    try {
      const url=new URL(path+'/socket',location.href)
      url.protocol=url.protocol==='https:'?'wss:':'ws:'
      ws=new WebSocket(url)
    } catch {setError('connection_lost');setBusy(false);return}
    socket.current=ws
    let started=false
    let concluded=false
    let issue=''
    ws.onopen=()=>{
      if (ws!==socket.current) return
      ws.send(JSON.stringify({type:'text.send',protocolVersion:1,clientMessageId,text,retry,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}))
    }
    ws.onmessage=({data})=>{
      if (ws!==socket.current) return
      let msg
      try {msg=JSON.parse(data)} catch {issue='connection_lost';ws.close();return}
      if (msg.type==='turn.started') {
        started=true;reusable.current=null;setDraft('');setActiveId(msg.turn.id)
        setTurns(rows=>[...rows.filter(row=>row.id!==msg.turn.id),msg.turn])
      } else if (msg.type==='text.delta') {
        setTurns(rows=>rows.map(row=>row.id===msg.turnId?{...row,assistantText:row.assistantText+msg.delta}:row))
      } else if (msg.type==='turn.ended') {concluded=true}
      else if (msg.type==='snapshot') {concluded=true;reusable.current=null;setDraft('')}
      else if (msg.type==='error') {issue=msg.code}
    }
    ws.onerror=()=>{issue='connection_lost'}
    ws.onclose=()=>{
      if (ws!==socket.current) return
      socket.current=null;setBusy(false);setActiveId('')
      if (issue || (!concluded && !started)) setError(issue || 'connection_lost')
      void refresh()
    }
  }
  function submit() {
    const text=draft.trim()
    if (!text || configured!==true || busy) return
    const existing=reusable.current
    const id=existing?.text===text?existing.id:crypto.randomUUID()
    reusable.current={id,text};send(text,id)
  }
  async function erase() {
    try {
      const r=await fetch(path,{method:'DELETE'})
      if (!r.ok) throw Error()
      if (!alive.current) return
      setConfirm(false);setMenu(false);setError('');setCursor(null);setTurns([]);void refresh()
    } catch { if (alive.current) setError('connection_lost') }
  }
  async function probe() {
    setProbing(true);setProbed(false);setError('')
    try {
      const r=await fetch('/api/chat/model/probe',{method:'POST'})
      if (!alive.current) return
      if (!r.ok) {setError((await r.json()).error || 'model_unavailable');return}
      setProbed(true);void refresh()
    } catch {if(alive.current)setError('connection_lost')}
    finally {if(alive.current)setProbing(false)}
  }
  const message=error==='model_unconfigured'?t.missing:error==='model_unavailable'?t.model:error==='busy'?t.busy:error==='login_required'?t.login:error==='reply_limit'?t.limit:error==='connection_lost'?t.network:t.invalid
  function bubble(turn:Turn,role:'user'|'assistant') {
    const text=role==='user'?turn.userText:turn.assistantText
    if (!text) return null
    return <div className={'duet-message '+role}>
      <p>{text}</p>
      {renderMessageAction?.({role,turnId:turn.id,text,createdAt:turn.createdAt,timeZone:turn.timeZone})}
    </div>
  }
  return <section className="duet-chat" aria-label={t.conversation}>
    <div className="duet-chatbar"><h2>{t.conversation}</h2><div className="duet-chattools">
      {renderCall?.({refresh,busy,setCallActive})}
      <button type="button" className="duet-more" aria-label={t.more} aria-expanded={menu} onClick={()=>setMenu(!menu)}>•••</button>
      {menu && <div className="duet-options"><button disabled={busy||probing||callActive} onClick={()=>void probe()}>{probing?t.working:t.check}</button><button disabled={!turns.length || busy || callActive} onClick={()=>{setConfirm(true);setMenu(false)}}>{t.clear}</button></div>}
    </div></div>
    {confirm && <div className="duet-notice"><span>{t.confirm}</span><button onClick={()=>setConfirm(false)}>{t.cancel}</button><button onClick={()=>void erase()}>{t.erase}</button></div>}
    {configured===false && <div className="duet-notice" role="status">{t.missing}</div>}
    {error && !(configured===false && error==='model_unconfigured') && <div className="duet-notice" role="alert"><span>{message}</span>{error==='connection_lost' && <button onClick={()=>void refresh()}>{t.reload}</button>}</div>}
    {probed && !error && <div className="duet-notice" role="status">{t.checked}</div>}
    <div className="duet-history" aria-label={t.history} ref={view} onScroll={()=>{const el=view.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<72}}>
      {cursor!==null && <button className="duet-older" onClick={()=>void refresh(cursor)}>{t.older}</button>}
      {!loaded && !error && <p className="duet-loading">{t.loading}</p>}
      {loaded && !turns.length && <div className="duet-empty">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><path d="M8 24c0-8 7-14 16-14s16 6 16 14-7 14-16 14c-2 0-5-.4-7-1.3L9 40l2-8c-2-2.1-3-5-3-8Z" fill="#dbe6d8"/><path d="M25 38c1.5 5 7.1 8 13 8 2.4 0 4.7-.6 6.6-1.5L51 47l-1.7-6.2c2-2 2.7-4.3 2.7-6.8 0-6.5-5.1-11.3-11.4-12.1" stroke="#779884" strokeWidth="1.6" strokeLinejoin="round"/></svg>
        <h3>{t.empty}</h3><p>{t.first(companion.name)}</p>
      </div>}
      {turns.map((turn,i)=>{
        const date=new Date(turn.createdAt)
        const nextDay=!i||date.toDateString()!==new Date(turns[i-1].createdAt).toDateString()
        return <div key={turn.id} className="duet-turn">
          {nextDay && <div className="duet-date"><span>{date.toDateString()===new Date().toDateString()?t.today:date.toLocaleDateString(lang==='zh'?'zh-CN':'en',{month:'short',day:'numeric',year:'numeric'})}</span></div>}
          <div className="duet-meta user">{t.you} · {date.toLocaleTimeString(lang==='zh'?'zh-CN':'en',{hour:'2-digit',minute:'2-digit'})}{turn.mode==='voice'?' · '+t.voice:''}</div>
          {bubble(turn,'user')}
          {(turn.assistantText || turn.id===activeId || turn.status==='failed' || turn.status==='interrupted') && <div className="duet-meta">{companion.name}</div>}
          {bubble(turn,'assistant')}
          {turn.id===activeId && !turn.assistantText && <div className="duet-status" role="status">{t.typing}</div>}
          {turn.status==='interrupted' && <div className="duet-status">{t.interrupted}</div>}
          {turn.status==='failed' && <div className="duet-status">{t.failed}{!turn.assistantText && i===turns.length-1 && <button disabled={busy||callActive} onClick={()=>send(turn.userText,turn.clientMessageId,true)}>{t.retry}</button>}</div>}
        </div>
      })}
    </div>
    <form className="duet-composer" onSubmit={event=>{event.preventDefault();submit()}}>
      <textarea ref={input} rows={2} maxLength={4000} value={draft} disabled={busy || callActive} aria-label={t.placeholder(companion.name)} placeholder={callActive?t.callActive:t.placeholder(companion.name)}
        onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{
          if (event.key==='Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode!==229 && !window.matchMedia('(pointer: coarse)').matches) {
            event.preventDefault();submit()
          }
        }}/>
      {busy?<button type="button" className="duet-send" aria-label={t.stop} title={t.stop} onClick={()=>{const ws=socket.current;if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'interrupt'}));else ws?.close()}}><Arrow stop/></button>
      :<button className="duet-send" type="submit" disabled={!draft.trim() || configured!==true || callActive} aria-label={t.send} title={t.send}><Arrow/></button>}
    </form>
  </section>
}
export default function Conversation(props:ChatProps) {return <Chat key={props.companion.id} {...props}/>}
