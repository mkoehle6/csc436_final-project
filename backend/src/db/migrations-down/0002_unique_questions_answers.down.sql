-- Reverses 0002_unique_questions_answers.sql (F5): removes the two unique indexes.
-- The cache rows cleared by the up migration are not restored; they were a
-- regenerable copy of Simpsons API data and refill on demand.
DROP INDEX IF EXISTS "questions_category_prompt_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "answers_session_question_uq";
