import Database from 'better-sqlite3'
import {afterEach,expect,test,vi} from 'vitest'
import {
  ackTurn,acquireWriter,configureChat,createConversation,deleteConversation,findTurn,getConversations,getHistory,
  initChat,runReply,selectConversation
} from '../src/server/chat/turns'

function setup() {
  const db=new Database(':memory:')
  db.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,name TEXT,persona TEXT,locale TEXT,voice TEXT);INSERT INTO companions VALUES ('a','Aya','','en-US',''),('b','Rin','','zh-CN','')")
  initChat(db)
  return db
}
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
test('new conversation preserves its sibling’s memories but excludes its messages, and deletion removes only the chosen source',async()=>{
  const db=setup()
  const prompts:string[]=[]
  vi.stubEnv('DUET_MODEL_BASE_URL','http://model.invalid/v1');vi.stubEnv('DUET_MODEL_NAME','fixture')
  vi.stubGlobal('fetch',async(_url:URL,opts:{body:string})=>{
    prompts.push(opts.body)
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
  })
  try {
    db.exec('CREATE TABLE fixture_memories(source_id TEXT REFERENCES chat_turns(id) ON DELETE CASCADE,fact TEXT)')
    configureChat(db,{context(database,companionId){
      const facts=database.prepare('SELECT fact FROM fixture_memories JOIN chat_turns ON chat_turns.id=source_id WHERE companion_id=?').all(companionId) as {fact:string}[]
      return facts.map(row=>row.fact).join('\n')
    }})
    const first=getConversations(db,'a').find(row=>row.active)!
    const signal=new AbortController().signal
    await runReply(db,'a','hidden earlier topic','same-id',signal,()=>{})
    const source=findTurn(db,'a','same-id')!
    db.prepare('INSERT INTO fixture_memories VALUES(?,?)').run(source.id,'remember my evening presentation')
    const second=createConversation(db,'a')
    expect(getHistory(db,'a').turns).toHaveLength(0)
    expect(db.prepare('SELECT source_id FROM fixture_memories').get()).toEqual({source_id:source.id})
    await runReply(db,'a','another topic','same-id',signal,()=>{},{conversationId:second.id})
    expect(prompts[1]).not.toContain('hidden earlier topic')
    expect(prompts[1]).toContain('remember my evening presentation')
    selectConversation(db,'a',first.id)
    expect(getHistory(db,'a').turns[0].userText).toBe('hidden earlier topic')
    expect(()=>selectConversation(db,'b',first.id)).toThrow('missing')
    expect(()=>acquireWriter(db,'a',second.id)).toThrow('conversation_changed')
    const call=acquireWriter(db,'a',first.id)
    expect(()=>selectConversation(db,'a',second.id)).toThrow('busy')
    expect(()=>createConversation(db,'a')).toThrow('busy')
    const spoken=await runReply(db,'a','same call','voice-id',call.signal,()=>{},{writer:call,mode:'voice'})
    deleteConversation(db,'a',first.id)
    expect(call.signal.aborted).toBe(true)
    expect(ackTurn(db,'a',spoken.id,2,call)).toBe(false)
    expect(getConversations(db,'a')).toMatchObject([{id:second.id,active:true}])
    expect(getHistory(db,'a').turns[0].userText).toBe('another topic')
    expect(db.prepare('SELECT COUNT(*) AS n FROM fixture_memories').get()).toEqual({n:0})
  } finally {db.close()}
})

test('migrates an existing companion and its dependent records without rebuilding its turn table',()=>{
  const db=new Database(':memory:')
  try {
    db.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,name TEXT,persona TEXT,locale TEXT,voice TEXT);
      INSERT INTO companions VALUES('a','Aya','','en-US','');
      CREATE TABLE chat_turns(id TEXT PRIMARY KEY,companion_id TEXT REFERENCES companions(id) ON DELETE CASCADE,
        client_message_id TEXT,user_text TEXT,delivered_text TEXT,mode TEXT,status TEXT,created_at INTEGER,time_zone TEXT, UNIQUE(companion_id,client_message_id));
      INSERT INTO chat_turns VALUES('legacy','a','old-id','before upgrade','yes','text','complete',10,'UTC');
      CREATE TABLE memories(source_id TEXT REFERENCES chat_turns(id) ON DELETE CASCADE);
      INSERT INTO memories VALUES('legacy');`)
    initChat(db)
    expect(getConversations(db,'a')).toHaveLength(1)
    expect(findTurn(db,'a','old-id')).toMatchObject({id:'legacy',userText:'before upgrade'})
    expect(db.prepare('SELECT source_id FROM memories').get()).toEqual({source_id:'legacy'})
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {db.close()}
})
