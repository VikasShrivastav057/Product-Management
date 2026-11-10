CREATE TABLE `portfolio_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `case_id` text NOT NULL,
  `title` text NOT NULL,
  `demo_url` text,
  `filename` text,
  `size` integer NOT NULL DEFAULT 0,
  `object_key` text UNIQUE,
  `idempotency_key` text,
  `created_at` integer NOT NULL,
  `deleting` integer NOT NULL DEFAULT 0 CHECK (`deleting` IN (0, 1)),
  UNIQUE (`user_id`, `idempotency_key`),
  CHECK (`demo_url` IS NOT NULL OR `object_key` IS NOT NULL),
  CHECK ((`object_key` IS NULL AND `filename` IS NULL AND `size` = 0) OR
         (`object_key` IS NOT NULL AND `filename` IS NOT NULL AND `size` BETWEEN 1 AND 10485760))
);
--> statement-breakpoint
CREATE INDEX `portfolio_entries_user_created` ON `portfolio_entries` (`user_id`, `created_at` DESC, `id` DESC);
