CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`tmdbId` integer,
	`list_id` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`posterUrl` text,
	`rating` integer,
	`overview` text,
	`releaseDate` integer,
	`duration` integer,
	`createdAt` integer DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `verifications` ADD `list_id` text REFERENCES lists(id);