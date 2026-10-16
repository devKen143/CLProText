# CLProText
A private, encrypted notebook with a minimalist green interface.

## Use
Open the published private site with your ChatGPT account. Create a notebook password of at least 12 characters. On another device, use the same account and notebook password. Click Save changes before leaving. Lock clears the decrypted notebook from the app state. A saved notebook locks after ten minutes without clicks or typing; unsaved edits pause automatic locking to prevent loss.

Titles and note bodies are encrypted in the browser. The server stores an AES-256-GCM envelope with a random 16-byte salt and fresh 12-byte IV. PBKDF2-SHA256 derives the encryption key using 600,000 iterations. Passwords and derived keys are not sent to the API or persisted in browser storage. This is an initial implementation, not an independently audited security product.

There is no password recovery. Keep your password and encrypted backups safe.

Export includes current edits, even when not saved. Import asks for the backup password and appends the decrypted notes; save to upload the result encrypted under the current notebook password. A conflicting save is rejected. Export your changes, reload and unlock the latest cloud notebook, then import your backup and reconcile any duplicate notes before saving.

The private hosting login is separate from the notebook password. Every API operation requires a hosting identity and isolates records by its user ID. Writes validate same-origin requests and use an atomic version comparison. No analytics or third-party page assets are used.

## Development
Use the Sites starter installation and build helpers. Database migrations are in drizzle/. For the development-only simulated identity, open /signin-with-chatgpt?return_to=/ on the local preview.

Crypto checks: node scripts/test-crypto.mjs
Type check: node node_modules/typescript/bin/tsc --noEmit
