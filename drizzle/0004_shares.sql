CREATE TABLE shares (
 id TEXT PRIMARY KEY NOT NULL,
 expires_at INTEGER NOT NULL,
 burn INTEGER NOT NULL CHECK (burn IN (0, 1)),
 created_at INTEGER NOT NULL,
 delete_token_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'burned', 'revoked', 'expired'))
);
CREATE INDEX shares_expiry ON shares(expires_at);
