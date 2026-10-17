ALTER TABLE `vaults` RENAME TO `legacy_vaults`;
--> statement-breakpoint
CREATE TABLE `vaults` (
	`username` text PRIMARY KEY NOT NULL,
	`write_token_hash` text NOT NULL,
	`version` integer NOT NULL,
	`blob_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
