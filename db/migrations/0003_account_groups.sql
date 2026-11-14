CREATE TABLE `account_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_groups_name_unique` ON `account_groups` (`name`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `account_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `group_members_user` ON `group_members` (`user_id`);--> statement-breakpoint
ALTER TABLE `canonical_accounts` ADD `group_id` text REFERENCES account_groups(id);--> statement-breakpoint
INSERT INTO `account_groups` (`id`, `name`, `protected`) VALUES ('unassigned', 'Unassigned', 1);--> statement-breakpoint
CREATE TEMP TABLE `_account_access_sets` AS
SELECT ca.`id` AS `account_id`,
  COALESCE((
    SELECT group_concat(aa.`user_id`, ',' ORDER BY aa.`user_id`)
    FROM `account_access` aa
    JOIN `users` u ON u.`id` = aa.`user_id` AND u.`role` = 'member'
    WHERE aa.`canonical_account_id` = ca.`id`
  ), '') AS `member_set`
FROM `canonical_accounts` ca;--> statement-breakpoint
CREATE TEMP TABLE `_migrated_groups` AS
SELECT `member_set`, 'group-' || lower(hex(randomblob(8))) AS `id`
FROM (SELECT DISTINCT `member_set` FROM `_account_access_sets` WHERE `member_set` <> '');--> statement-breakpoint
INSERT INTO `account_groups` (`id`, `name`, `protected`)
SELECT g.`id`,
  'Shared with ' || (
    SELECT group_concat(u.`username`, ', ' ORDER BY u.`username`)
    FROM `users` u
    WHERE instr(',' || g.`member_set` || ',', ',' || u.`id` || ',') > 0
  ),
  0
FROM `_migrated_groups` g;--> statement-breakpoint
INSERT INTO `group_members` (`group_id`, `user_id`)
SELECT g.`id`, u.`id`
FROM `_migrated_groups` g
JOIN `users` u ON instr(',' || g.`member_set` || ',', ',' || u.`id` || ',') > 0;--> statement-breakpoint
UPDATE `canonical_accounts`
SET `group_id` = COALESCE(
  (SELECT g.`id` FROM `_account_access_sets` s JOIN `_migrated_groups` g ON g.`member_set` = s.`member_set` WHERE s.`account_id` = `canonical_accounts`.`id`),
  'unassigned'
);--> statement-breakpoint
DROP TABLE `_migrated_groups`;--> statement-breakpoint
DROP TABLE `_account_access_sets`;
