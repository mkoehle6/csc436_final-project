-- Reverses 0003_live_events.sql (F5). Live events are a short-lived replay buffer;
-- dropping them only means reconnecting clients get a fresh snapshot instead of a replay.
DROP TABLE IF EXISTS "live_events";
