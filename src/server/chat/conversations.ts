import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ChatError } from './model'

type DB = Database.Database
export type ConversationSummary = {id:string; createdAt:number; title:string; active:boolean}

export function migrateConversations(db:DB) {
  db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY, companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)));
      CREATE UNIQUE INDEX IF NOT EXISTS chat_active_conversation ON chat_conversations(companion_id) WHERE active=1;
      CREATE INDEX IF NOT EXISTS chat_companion_conversations ON chat_conversations(companion_id,created_at);`)
    const columns=db.pragma('table_info(chat_turns)') as {name:string}[]
    if (!columns.some(col=>col.name==='conversation_id')) {
      // Keep row IDs and dependent memory/mood foreign keys intact on existing installations.
      db.exec(`ALTER TABLE chat_turns ADD COLUMN conversation_id TEXT REFERENCES chat_conversations(id) ON DELETE CASCADE;
        ALTER TABLE chat_turns ADD COLUMN request_id TEXT;
        INSERT INTO chat_conversations(id,companion_id,created_at,active)
        SELECT lower(hex(randomblob(16))),companion_id,MIN(created_at),1 FROM chat_turns GROUP BY companion_id;
        UPDATE chat_turns SET request_id=client_message_id,
          conversation_id=(SELECT id FROM chat_conversations WHERE companion_id=chat_turns.companion_id AND active=1);`)
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS chat_conversation_request ON chat_turns(conversation_id,request_id);`)
  })()
}
export function insertConversation(db:DB,companionId:string):ConversationSummary {
  const createdAt=Date.now()
  const id=randomUUID()
  db.prepare('INSERT INTO chat_conversations(id,companion_id,created_at,active) VALUES(?,?,?,1)').run(id,companionId,createdAt)
  return {id,createdAt,title:'',active:true}
}
export function activeConversation(db:DB,id:string,expected?:string) {
  let current=db.prepare('SELECT id FROM chat_conversations WHERE companion_id=? AND active=1').get(id) as {id:string}|undefined
  if (!current) {
    if (!db.prepare('SELECT 1 FROM companions WHERE id=?').get(id)) throw new ChatError('missing')
    if (expected) throw new ChatError('conversation_changed')
    current=insertConversation(db,id)
  }
  if (expected && current.id!==expected) throw new ChatError('conversation_changed')
  return current.id
}
export function getConversations(db:DB,id:string):ConversationSummary[] {
  activeConversation(db,id)
  const rows=db.prepare(`SELECT c.id,c.created_at AS createdAt,c.active,
    COALESCE((SELECT substr(user_text,1,48) FROM chat_turns WHERE conversation_id=c.id ORDER BY rowid LIMIT 1),'') AS title
    FROM chat_conversations c WHERE c.companion_id=? ORDER BY c.created_at DESC,c.rowid DESC`).all(id) as (Omit<ConversationSummary,'active'>&{active:number})[]
  return rows.map(row=>({...row,active:Boolean(row.active)}))
}
