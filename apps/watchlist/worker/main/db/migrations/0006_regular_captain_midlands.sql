CREATE TABLE `list_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`list_id` text NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unique_list_tag` ON `list_tags` (`list_id`,`name`);--> statement-breakpoint
CREATE TABLE `list_tags_to_items` (
	`list_tag_id` text NOT NULL,
	`list_item_id` text NOT NULL,
	PRIMARY KEY(`list_tag_id`, `list_item_id`),
	FOREIGN KEY (`list_tag_id`) REFERENCES `list_tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_item_id`) REFERENCES `list_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `list_item_tags`;