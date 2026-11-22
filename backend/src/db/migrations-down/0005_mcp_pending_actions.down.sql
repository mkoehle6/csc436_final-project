-- Reverses 0005_mcp_pending_actions.sql (F5). Pending confirmations are short-lived;
-- dropping them only means an unconfirmed add_question must be requested again.
DROP TABLE IF EXISTS "mcp_pending_actions";
