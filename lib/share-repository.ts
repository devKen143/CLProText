import type { ShareRepository, ShareRow } from './share-api';
type StoredShare = {id:string;expires_at:number;burn:number;created_at:number;delete_token_hash:string;state:ShareRow['state']};
const unpack = (row:StoredShare|null):ShareRow|undefined => row ? {id:row.id,expiresAt:row.expires_at,burn:!!row.burn,createdAt:row.created_at,deleteTokenHash:row.delete_token_hash,state:row.state} : undefined;
export function shareRepository(db:D1Database):ShareRepository {
 return {
  get:async id=>unpack(await db.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<StoredShare>()),
  create:async row=>{await db.prepare('INSERT INTO shares (id,expires_at,burn,created_at,delete_token_hash,state) VALUES (?,?,?,?,?,?)').bind(row.id,row.expiresAt,Number(row.burn),row.createdAt,row.deleteTokenHash,row.state).run();},
  acquire:async(id,now)=>unpack(await db.prepare("UPDATE shares SET state = CASE WHEN burn = 1 THEN 'burned' ELSE 'active' END WHERE id = ? AND state = 'active' AND expires_at > ? RETURNING *").bind(id,now).first<StoredShare>()),
  expire:async(id,now)=>{await db.prepare("UPDATE shares SET state = 'expired' WHERE id = ? AND state = 'active' AND expires_at <= ?").bind(id,now).run();},
  revoke:async(id,hash)=>{await db.prepare("UPDATE shares SET state = 'revoked' WHERE id = ? AND delete_token_hash = ?").bind(id,hash).run();},
 };
}
