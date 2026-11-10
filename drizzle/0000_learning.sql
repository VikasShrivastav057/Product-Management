CREATE TABLE `attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `items_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `score` integer,
  `answers_json` text,
  CHECK (`score` BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE INDEX `attempts_user_created` ON `attempts` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `certificates` (
  `user_id` text PRIMARY KEY NOT NULL,
  `id` text UNIQUE NOT NULL,
  `name` text NOT NULL,
  `score` integer NOT NULL,
  `awarded_at` integer NOT NULL,
  CHECK (`score` BETWEEN 8 AND 10)
);
