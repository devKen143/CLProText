import { getChatGPTUser } from '../../chatgpt-auth';
import { getDb } from '../../../db';
import { vaults } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const usernamePattern = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/;
function publicUsername(request: Request): string | null | undefined {
 const raw = new URL(request.url).searchParams.get('username');
 if (raw === null) return undefined;
 const value = raw.toLowerCase();
 return usernamePattern.test(value) ? value : null;
}
async function ownerFor(request: Request): Promise<string | null> {
 const username = publicUsername(request);
 if (username === null) return null;
 if (username) return `public:${username}`;
 const user = await getChatGPTUser();
 return user?.userId || null;
}
export async function GET(request: Request) {
 const owner = await ownerFor(request);
 if (!owner) return json({ error: 'Sign in to your private site to access your notebook.' }, 401);
 const row = await getDb().select().from(vaults).where(eq(vaults.owner, owner)).get();
 return json(row ? { payload: JSON.parse(row.payload), version: row.version } : { payload: null, version: 0 });
}
export async function PUT(request: Request) {
 const owner = await ownerFor(request);
 if (!owner) return json({ error: 'Your session expired. Sign in again before saving.' }, 401);
 if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Invalid origin.' }, 403);
 if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Invalid content type.' }, 415);
 const raw = await request.text();
 if (raw.length > 2000000) return json({ error: 'Notebook is too large (2 MB maximum encrypted size).' }, 413);
 let body;
 try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid data.' }, 400); }
 if (!body || typeof body !== 'object') return json({ error: 'Invalid data.' }, 400);
 const { payload: p, version } = body;
 if (!Number.isSafeInteger(version) || version < 0 || !p || p.format !== 1 || p.iterations !== 600000 || !/^[A-Za-z0-9+/]{22}==$/.test(p.salt) || !/^[A-Za-z0-9+/]{16}$/.test(p.iv) || typeof p.data !== 'string' || p.data.length < 24 || !/^[A-Za-z0-9+/]+=*$/.test(p.data)) return json({ error: 'Invalid encrypted notebook.' }, 400);
 const payload = JSON.stringify({ format: 1, iterations: 600000, salt: p.salt, iv: p.iv, data: p.data });
 const db = getDb();
 const row = version === 0
 ? await db.insert(vaults).values({ owner, payload, version: 1 }).onConflictDoNothing().returning().get()
 : await db.update(vaults).set({ payload, version: version + 1 }).where(and(eq(vaults.owner, owner), eq(vaults.version, version))).returning().get();
 if (!row) return json({ error: 'Another device saved a newer version. Export your encrypted backup before reloading. Your edits are still here.' }, 409);
 return json({ version: row.version });
}
