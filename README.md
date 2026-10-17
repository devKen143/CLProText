# CLProText
Local-first, browser-encrypted notebooks at /username with optional Cloudflare D1 + R2 sync.

## Local use
Choose a username and password. Local notebooks use per-username IndexedDB. Legacy localStorage entries under clprotext:vault:<username> migrate non-destructively on unlock. No account or email login is needed. Local-only is the default and makes no cloud vault requests. Sync preferences (not passwords or tokens) use localStorage.

Use Save changes in local-only mode. With Sync to cloud enabled, edits are debounced, saved atomically in IndexedDB, then uploaded. Deleting a note removes it from the persisted snapshot. Browser storage failure keeps the editor's unsaved state and prevents uploading that failed save. Export backups before clearing browser data. Keep your password: there is no recovery.

The production service worker caches visited app pages/assets, never /api requests. Visit a notebook online first and reload once to ensure the shell/assets are cached; then reopening that cached page works offline. Development can run without internet through the local server. Cloud transfer needs a connection. A missing binding/API returns an error only when sync is requested; local editing still works.

## Cloud use
- Unlock a local notebook and enable **Sync to cloud**. First sync checks whether the username is claimed; a missing cloud notebook is created using your password-derived write token.
- On another device, enter the same username and password, then choose **Open cloud notebook with this password**. No password confirmation is needed for downloading.
- Status shows local only / syncing / synced / conflict / offline error.
- Saved edits upload after a debounce. Failed requests retry after connectivity returns or every 30 seconds while the notebook is unlocked, unless a conflict requires a choice. Retry sync is also available.
- Automatic pulls never replace differing local content. Export a local backup, then explicitly choose **Keep local; replace cloud** or **Load cloud; replace local**. The latter fetches the latest cloud snapshot and validates/decrypts it before replacing local records.
- Turn sync off to stop future automatic uploads. This does not delete the cloud copy. **Delete cloud copy** requires the password-derived token and a current version; it keeps local notes.
- For a cloud password change, delete the cloud copy with the old password first, change the local password, then re-enable sync. Local password changes remain available with sync off, but any existing cloud copy keeps its old password and cannot be updated using the new password. Export a backup before this process.

## Setup
Node 22.13+ (Node 24 recommended). Install with npm ci, then npm run dev. The existing localhost development sign-in bypass remains in the starter. The vault API itself does not require that sign-in. Any hosting-wide access policy is separate.

Create resources in your Cloudflare account:
    npx wrangler d1 create clprotext
    npx wrangler r2 bucket create clprotext-vaults

Copy the returned database ID into wrangler.jsonc. The all-zero placeholder is for local emulation only. DB and BUCKET are typed in cloudflare-env.d.ts. Vite reads the same D1 ID and binding names, with .wrangler/state as local persistence. If .openai/hosting.json exists, set d1 to DB and r2 to BUCKET; otherwise the Vite config uses those bindings by default.

Apply migrations:
    npx wrangler d1 migrations apply clprotext --local --persist-to .wrangler/state
    npx wrangler d1 migrations apply clprotext --remote

For a NEW database these apply both migrations. Migration 0001 renames the old vaults table to legacy_vaults and creates the metadata-only vaults table. Existing legacy rows are preserved and are not automatically published or claimed. If 0000 was previously applied manually, first reconcile Wrangler's migration history; do not replay CREATE TABLE or delete old data.

Run:
    npm run dev
    npm run typecheck
    npm run test:sync
    npm run build

Wrangler local D1 and R2 emulation requires no Cloudflare login:
    npx wrangler dev --config wrangler.jsonc --local --persist-to .wrangler/state

Build before running Wrangler directly. For a standalone deployment, set the real resource IDs, apply remote migrations and use:
    npx wrangler deploy --config wrangler.jsonc

Publishing/resource creation is not performed by the test suite. Configure rate limiting before exposing /api/vault publicly: there is an explicit injection hook in lib/vault-api.ts and a deployment TODO in app/api/vault/route.ts. Use a distributed Cloudflare limiter/WAF rule covering GET, PUT and DELETE by source IP and request size, not an isolate-local counter. Keep request-body logging disabled.

## API and security model
GET /api/vault?username=alice returns {blob,version} or 404.
PUT /api/vault accepts {username,writeToken,expectedVersion,blob}; first claim uses expectedVersion 0 and returns version 1. Later writes require the matching token and expected version. Stale writes return 409 with the current version.
DELETE /api/vault accepts {username,writeToken,expectedVersion}.

Usernames are trimmed and lowercased client-side; the API accepts only canonical names matching the shared pattern in lib/sync-contract.ts. The server validates formats, media type, body size and same-origin browser writes. Missing cloud infrastructure returns 503; malformed input 400/415; invalid token 403; excessive size 413.

The browser compresses the full notebook snapshot (including attachment names, MIME types, sizes and contents) and encrypts it with AES-256-GCM and a fresh random salt/IV. PBKDF2-SHA256 uses 600,000 iterations for both the encryption key and the independently derived write token. The write-token salt is the explicit, separate CLProText:write-token:v1:<username> context. Neither the password nor the encryption key is transmitted. The server receives a bearer write token over HTTPS and stores only its SHA-256 hash, compared without an early character mismatch exit.

D1 stores username, token hash, version, R2 key, ciphertext size and timestamps. R2 stores only encrypted snapshots. The server can see usernames, sizes, versions, access timing and IP/network metadata, but not notes or attachment names. GET is public at the application layer: someone who guesses a username can download ciphertext and attempt offline password guessing. A compromised token permits writes/deletion but does not directly derive the encryption key; weak passwords remain vulnerable to dictionary attacks. Use a strong unique passphrase. Browser-delivered code and the device remain part of the trust model; this is not an independent security audit.

Each version uses a unique immutable R2 object key. After uploading, an atomic D1 comparison of username, version, token hash and prior blob key publishes the pointer. A losing concurrent writer cannot corrupt the winning blob. Failed/ambiguous commits can leave orphaned ciphertext. Old snapshots are deleted best-effort after a successful pointer update; GET retries metadata if racing cleanup. A scheduled orphan cleanup job is not included. Never delete objects unless they are confirmed unreferenced and outside a suitable grace period.

## Limits and implementation notes
- MAX_BLOB_BYTES is 8 MiB (serialized encrypted envelope), with a bounded streaming request reader.
- Each attachment is at most 5 MiB; several attachments can exceed the total encrypted snapshot limit. That failure does not delete the local working copy.
- Client decompression is bounded at 32 MiB. Gzip is used before encryption; modern CompressionStream/DecompressionStream support is required for cloud sync.
- Whole-notebook snapshots, no realtime collaboration, no server-side search, no MongoDB.
- D1 and R2 are not a single transaction. Immutable blobs plus conditional metadata publication prevent stale overwrite; orphan cleanup remains operational work.
- The actual project already used IndexedDB, so this change intentionally does not downgrade it to localStorage.
- Existing encrypted export/import remains compatible. Cloud encryption wraps all metadata; the older local export format has clear attachment metadata.
- The write token lives only in memory while unlocked. Disabling sync or locking drops the cached token. Password rotation does not silently rotate a cloud token.
- Optional sync preference is per username/browser, and does not contain credentials.

## Tests
npm run test:sync covers distinct write-token derivation, encrypted notes/attachments (including random 5 MiB files), wrong-password/tamper rejection, create/update/delete/read, concurrent claims/saves, 409/403/400/413/503 responses, failed object upload, and non-destructive SQLite migration.
Drizzle generated the new snapshot and SQL through scripts/generate-sync-migration.mjs because the CLI's tsx loader failed on this Windows sandbox's os.userInfo call. That script refuses to overwrite the migration; use ordinary append-only Drizzle migrations for future schema changes.
