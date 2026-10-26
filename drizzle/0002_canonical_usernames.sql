-- Refuse deployment if legacy names collide. Resolve collisions manually without deleting vaults.
CREATE UNIQUE INDEX vaults_canonical_username ON vaults(lower(trim(username)));
