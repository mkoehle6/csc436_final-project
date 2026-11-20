-- Reverses 0001_auth_sessions.sql (F5). Indexes are dropped with their tables.
-- Data loss on rollback: in-flight logins and refresh sessions only; users must sign in again.
DROP TABLE IF EXISTS `auth_sessions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `oauth_login_states`;
