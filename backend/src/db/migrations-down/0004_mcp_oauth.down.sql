-- Reverses 0004_mcp_oauth.sql (F5). Drops MCP OAuth state: connected MCP clients
-- must authorize again. Refresh tokens first (they reference codes).
DROP TABLE IF EXISTS "oauth_refresh_tokens";
--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_authorization_codes";
--> statement-breakpoint
ALTER TABLE "oauth_login_states" DROP COLUMN IF EXISTS "return_to";
