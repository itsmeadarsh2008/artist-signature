CREATE TABLE `artist_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`artist_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized_alias` text NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artist_aliases_normalized_idx` ON `artist_aliases` (`normalized_alias`);--> statement-breakpoint
CREATE TABLE `artists` (
	`id` text PRIMARY KEY NOT NULL,
	`musicbrainz_id` text,
	`wikidata_id` text,
	`name` text NOT NULL,
	`sort_name` text,
	`normalized_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artists_musicbrainz_id_unique` ON `artists` (`musicbrainz_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artists_wikidata_id_unique` ON `artists` (`wikidata_id`);--> statement-breakpoint
CREATE INDEX `artists_normalized_name_idx` ON `artists` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `category_queue` (
	`category_title` text PRIMARY KEY NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`discovered_at` text NOT NULL,
	`processed_at` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `import_items` (
	`source_title` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'wikimedia_commons' NOT NULL,
	`state` text DEFAULT 'DISCOVERED' NOT NULL,
	`page_id` integer,
	`revision_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_runs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`items_processed` integer DEFAULT 0 NOT NULL,
	`items_failed` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`signature_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`usage_terms` text,
	`attribution_required` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	FOREIGN KEY (`signature_id`) REFERENCES `signatures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`signature_id` text,
	`action` text NOT NULL,
	`actor` text DEFAULT 'admin' NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`signature_id`) REFERENCES `signatures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`signature_id` text NOT NULL,
	`method` text NOT NULL,
	`confidence` real NOT NULL,
	`raw_name` text,
	`matched_artist_id` text,
	`reviewed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`signature_id`) REFERENCES `signatures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`artist_id` text,
	`type` text DEFAULT 'unknown' NOT NULL,
	`format` text DEFAULT 'other' NOT NULL,
	`sha256` text,
	`width` integer,
	`height` integer,
	`file_size` integer,
	`asset_url` text,
	`status` text DEFAULT 'available' NOT NULL,
	`verification` text DEFAULT 'unverified' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_sha256_unique` ON `signatures` (`sha256`);--> statement-breakpoint
CREATE INDEX `signatures_artist_idx` ON `signatures` (`artist_id`);--> statement-breakpoint
CREATE INDEX `signatures_sha256_idx` ON `signatures` (`sha256`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`signature_id` text,
	`provider` text NOT NULL,
	`source_url` text,
	`original_url` text,
	`source_title` text,
	`source_id` text,
	`revision_id` text,
	`imported_at` text NOT NULL,
	FOREIGN KEY (`signature_id`) REFERENCES `signatures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `takedowns` (
	`id` text PRIMARY KEY NOT NULL,
	`signature_id` text NOT NULL,
	`source` text,
	`reason` text NOT NULL,
	`requester` text NOT NULL,
	`contact` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`signature_id`) REFERENCES `signatures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `unresolved_signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_title` text NOT NULL,
	`description` text,
	`categories` text,
	`wikidata_id` text,
	`candidates` text,
	`confidence` real,
	`provider` text DEFAULT 'wikimedia_commons' NOT NULL,
	`page_url` text,
	`original_url` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`imported_at` text NOT NULL
);
