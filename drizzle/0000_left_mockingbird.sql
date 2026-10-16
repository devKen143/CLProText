CREATE TABLE `vaults` (
	`owner` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`version` integer NOT NULL
);
