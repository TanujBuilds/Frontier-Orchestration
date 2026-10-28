import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, identifier } from './contracts.mjs';

export class Store {
 constructor(root){
  this.root=path.resolve(root);mkdirSync(this.root,{recursive:true,mode:0o700});
  this.db=new DatabaseSync(path.join(this.root,'harness.sqlite3'));
  chmodSync(path.join(this.root,'harness.sqlite3'),0o600);this.depth=0;
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS submissions(kind TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(kind,scope,key));
   CREATE TABLE IF NOT EXISTS commands(key TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,goal_id TEXT,task_id TEXT,type TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(task_id,key));
   CREATE INDEX IF NOT EXISTS requests_task ON requests(task_id,kind);
   PRAGMA user_version=1;`);
 }
 close(){if(this.db){this.db.close();this.db=null;}}
 tx(fn){if(this.depth)return fn();this.db.exec('BEGIN IMMEDIATE');this.depth++;try{const value=fn();if(value?.then)throw Error('Async work cannot run inside state transaction');this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.depth--;}}
 get(kind,id){const row=this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id);if(!row)throw Error(`Unknown ${kind}: ${id}`);return JSON.parse(row.data);}
 maybe(kind,id){try{return this.get(kind,id);}catch(e){if(e.message.startsWith('Unknown '))return null;throw e;}}
 all(kind){return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r=>JSON.parse(r.data));}
 put(kind,value){this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,canonical(value));return value;}
 event(type,{goalId=null,taskId=null,data={},at=Date.now()}={}){return Number(this.db.prepare('INSERT INTO events(at,goal_id,task_id,type,data) VALUES(?,?,?,?,?)').run(at,goalId,taskId,type,canonical(data)).lastInsertRowid);}
 events(after=0,limit=100){return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,Math.min(1000,limit)).map(r=>({...r,data:JSON.parse(r.data)}));}
 command(key,input,fn){identifier(key,'idempotencyKey');const hash=digest(input);return this.tx(()=>{const old=this.db.prepare('SELECT * FROM commands WHERE key=?').get(key);if(old){if(old.hash!==hash)throw Error('Idempotency key conflict');return JSON.parse(old.result);}const result=fn();this.db.prepare('INSERT INTO commands(key,hash,result) VALUES(?,?,?)').run(key,hash,canonical(result));return result;});}
 submission(kind,scope,key,hash,create){const old=this.db.prepare('SELECT * FROM submissions WHERE kind=? AND scope=? AND key=?').get(kind,scope,key);if(old){if(old.hash!==hash)throw Error('Submission conflict');return this.get(kind,old.id);}const result=create(randomUUID());this.put(kind,result);this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?)').run(kind,scope,key,result.id,hash);return result;}
 request(taskId,key){const row=this.db.prepare('SELECT * FROM requests WHERE task_id=? AND key=?').get(taskId,key);return row?{...row,...JSON.parse(row.data)}:null;}
 spent(taskId){return Object.fromEntries(this.db.prepare('SELECT kind,COUNT(*) AS n FROM requests WHERE task_id=? GROUP BY kind').all(taskId).map(r=>[r.kind,Number(r.n)]));}
}
