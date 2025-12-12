CREATE TABLE `list_item_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`list_item_id` text NOT NULL,
	FOREIGN KEY (`list_item_id`) REFERENCES `list_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_tag` ON `list_item_tags` (`list_item_id`,`name`);--> statement-breakpoint
ALTER TABLE `list_items` ADD `watchedAt` integer;