# Cross-device login and recovery (P0)

Fresh devices query `GET /api/vault?username=…&exists=1`. Only 404 permits creation.
POST claims a name before local creation; duplicate claims return 409. Cloud
downloads authenticate before an atomic IndexedDB install. Cloud and local salts
may differ: every snapshot carries its own salt and 600000 iterations. Write tokens
are password-derived with a separate PBKDF2 context, reproducible on another device.

Apply migration 0002 before deploying. It adds a unique canonical username index.
First inspect collisions (read-only):

```sql
SELECT lower(trim(username)) AS canonical, count(*) AS count
FROM vaults GROUP BY canonical HAVING count(*) > 1;
SELECT username, blob_key FROM vaults;
SELECT owner, version FROM legacy_vaults;
```

The application retains original row names for legacy encryption AAD/token
derivation and resolves canonical lookups without rewriting ciphertext. Ambiguous
names fail closed. Local IndexedDB names are similarly resolved once per session
using database enumeration; legacy localStorage keys are retained.

## Read-only orphan audit

Export `SELECT blob_key FROM vaults` as an array of `{ "blob_key": "…" }` to
`rows.json`. Obtain a complete paginated R2 object inventory via your administrator
tooling as an array of `{ "key": "…" }` in `objects.json`. Do not export payloads,
passwords, or write-token hashes. Run:

```sh
node scripts/audit-vault-orphans.mjs rows.json objects.json
```

The script performs no network calls and never modifies/deletes anything. Repeat
the inventory during a write-free maintenance window to rule out in-flight writes.
Unreferenced objects include intentionally retained older snapshots; they are not
automatically safe to delete.

Any R2 key, including `vaults_micro_<uuid>`, works when the D1 row's `blob_key`
points to it: the handler follows that pointer verbatim. Only an unindexed opaque
key cannot be mapped to a username by this code. Preserve it and recover its
original metadata/owner mapping from the prior deployment,
then verify its encryption format/AAD with that deployment's source before importing
or registering it. Do not invent a token hash or automatically claim legacy data.
The current format-2 reader uses `CLProText:cloud:v2:<original username>` as AAD;
format 1 uses `CLProText:v1`. No other legacy format was found in this checkout.

## Failure boundaries

D1 and R2 do not support a shared transaction. Uploads use immutable unique keys
and R2 conditional creation; D1 publishes the pointer with a conditional insert or
compare-and-swap. Definite losers are rolled back. If a D1 write response is lost,
the handler rereads metadata to reconcile success before compensating. If both
write and reconciliation fail, it retains ciphertext rather than risking deletion
of a committed vault. Process termination can also leave an orphan; use the audit.
No save rewrites or deletes an existing R2 snapshot.

P1 remains separate: password rotation, richer conflict recovery/status UI, local
empty-vault password verification, and replacing the page's per-note save loop.
Until P1, do not rotate a cloud notebook's password using the local-only control.
