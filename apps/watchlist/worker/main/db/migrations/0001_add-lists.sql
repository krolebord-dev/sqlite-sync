CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`createdAt` integer DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users_to_lists` (
	`user_id` text NOT NULL,
	`list_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `list_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade
);
