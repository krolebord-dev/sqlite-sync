CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`validUntil` integer NOT NULL,
	`createdAt` integer DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`createdAt` integer DEFAULT (current_timestamp) NOT NULL,
	`updatedAt` integer DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`targetType` text NOT NULL,
	`target` text NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer DEFAULT (current_timestamp) NOT NULL,
	`expiredAt` integer NOT NULL,
	`usedAt` integer,
	`isValid` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verifications_token_unique` ON `verifications` (`token`);