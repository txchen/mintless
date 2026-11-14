ALTER TABLE `users` ADD `password_set_by` text DEFAULT 'cli' NOT NULL;--> statement-breakpoint
UPDATE `users` SET `password_set_by` = 'admin' WHERE `role` = 'member';
