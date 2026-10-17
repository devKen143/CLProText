import { env } from 'cloudflare:workers';
import { createVaultHandler } from '../../../lib/vault-api';
import { cloudRepository } from '../../../lib/cloud-repository';
export const dynamic = 'force-dynamic';
const handler = createVaultHandler(() => {
 if (!env.DB || !env.BUCKET) return null;
 const bucket = env.BUCKET;
 return {
  repository: cloudRepository(env.DB),
  blobs: {
   get: async (key: string) => { const object = await bucket.get(key); return object ? object.text() : null; },
   put: async (key: string, value: string) => { await bucket.put(key,value,{httpMetadata:{contentType:'application/json'}}); },
   delete: async (key: string) => { await bucket.delete(key); },
  },
  // TODO before public deployment: distributed Cloudflare rate limiting by IP
  // for all /api/vault methods. Never log bodies, passwords or write tokens.
 };
});
export const GET = handler;
export const PUT = handler;
export const DELETE = handler;
