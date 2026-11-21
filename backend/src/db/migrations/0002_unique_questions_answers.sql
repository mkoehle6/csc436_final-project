-- Before 0002 the API inserted a fresh batch of questions on every page view, using a
-- generator that did not filter unnamed extras or "Unknown" occupations. Those rows are
-- a regenerable cache of Simpsons API data, and none is referenced by an answer (the
-- frontend did not record answers before this release), so they are cleared here and
-- the bank refills on demand from the cleaned generator. Questions that ARE referenced
-- by an answer are kept, preserving foreign-key integrity and the audit trail.
DELETE FROM "questions" q
WHERE NOT EXISTS (SELECT 1 FROM "answers" a WHERE a."question_id" = q."id");
--> statement-breakpoint
-- Keep only the first answer if a session somehow answered the same question twice.
DELETE FROM "answers" a USING "answers" b
WHERE a."session_id" = b."session_id" AND a."question_id" = b."question_id" AND a."id" > b."id";
--> statement-breakpoint
CREATE UNIQUE INDEX "answers_session_question_uq" ON "answers" USING btree ("session_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_category_prompt_uq" ON "questions" USING btree ("category","prompt");
