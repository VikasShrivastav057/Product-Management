CREATE TABLE `tutor_usage` (
  `user_id` text NOT NULL,
  `day` text NOT NULL,
  `count` integer NOT NULL,
  PRIMARY KEY (`user_id`, `day`)
);
