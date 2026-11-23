# F6: audit trail (query output)

**Table:** `audit_log` (`backend/src/db/schema.ts`). **Writer:**
`backend/src/lib/audit.ts` (`recordAudit`). The application only ever **inserts**
into this table; no code path updates or deletes audit rows.

Each row answers:
* **who:** `actor_user_id`, taken from the *validated* access token, never from the
  request body. `NULL` means the system or an administrator's CLI.
* **what:** `action` + `entity_type` + `entity_id`.
* **when:** `created_at`, set by the database (`timestamptz`).
* **before → after:** JSON snapshots of the changed state.

## Audited actions

| Action | Written by | Before / after |
| --- | --- | --- |
| `user.create` | first Google login | – / id, role |
| `user.role_change` | `npm run user:set-role`, or `BOOTSTRAP_OPERATOR_EMAILS` | old role / new role (+ reason) |
| `auth.login`, `auth.logout` | web sign-in / sign-out | – / user, expiry; `revokedAt` null / set |
| `session.start` | `POST /api/sessions`, MCP `play_trivia` | – / session (+ `via`: web or mcp) |
| `answer.submit` | `POST /api/sessions/:id/answers`, MCP `submit_answer` | score before / verdict, score after |
| `question.create` | `POST /api/questions`, MCP `add_question` (after confirmation) | – / full question |
| `question.delete` | `DELETE /api/questions/:id` | full question / – |
| `oauth.consent_granted`, `oauth.consent_denied` | MCP consent screen | – / client id (+ name), scopes |
| `mcp.tool_call` | every MCP tool call | – / tool, client id, outcome, summarized arguments |

`answer.submit` is written **in the same database transaction** as the answer and
the score update (`backend/src/lib/gameplay.ts`). A recorded answer without its
audit row, or the reverse, cannot exist.

## Query output (local evidence run)

Run 2026-11-23 ~05:09 UTC: the compiled backend on a file-backed PGlite database,
synthetic users `viewer@example.invalid` and `operator@example.invalid`, created
through the **same function a real Google login calls** (`upsertUser`). The operator
was promoted with the real CLI:

```
$ npm run user:set-role -- operator@example.invalid operator
User 2: viewer -> operator.
```

Then these API calls were made:

```
viewer: POST /api/sessions -> 201
viewer: POST /api/sessions/1/answers (q1, Right) -> 201  (correct)
viewer: POST /api/sessions/1/answers (q2, W1) -> 201     (wrong)
viewer: POST /api/questions (forbidden) -> 403 {"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}
operator: POST /api/questions -> 201 (id 73, "Who owns the Leftorium?")
operator: DELETE /api/questions/73 -> 204
operator: DELETE /api/questions/1 (has answers) -> 409 {"error":{"code":"CONFLICT",...}}
```

```sql
SELECT a.id, to_char(a.created_at AT TIME ZONE 'UTC','HH24:MI:SS') AS at_utc,
       coalesce(u.email, '(system/CLI)') AS actor, a.action,
       a.entity_type || coalesce(':' || a.entity_id, '') AS entity,
       coalesce(a.before::text, '') AS before, coalesce(a.after::text, '') AS after
FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
ORDER BY a.id;
```

| id | at (UTC) | actor | action | entity | before | after |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 05:09:21 | viewer@example.invalid | `user.create` | user:1 | | `{"id": 1, "role": "viewer"}` |
| 2 | 05:09:21 | operator@example.invalid | `user.create` | user:2 | | `{"id": 2, "role": "viewer"}` |
| 3 | 05:09:28 | (system/CLI) | `user.role_change` | user:2 | `{"role": "viewer"}` | `{"role": "operator"}` |
| 4 | 05:09:48 | viewer@example.invalid | `session.start` | game_session:1 | | `{"id": 1, "via": "web", "score": 0, "userId": 1, "startedAt": "2026-11-23T05:09:48.095Z", "completedAt": null}` |
| 5 | 05:09:48 | viewer@example.invalid | `answer.submit` | answer:1 | `{"score": 0}` | `{"via": "web", "score": 10, "isCorrect": true, "sessionId": 1, "questionId": 1}` |
| 6 | 05:09:48 | viewer@example.invalid | `answer.submit` | answer:2 | `{"score": 10}` | `{"via": "web", "score": 10, "isCorrect": false, "sessionId": 1, "questionId": 2}` |
| 7 | 05:09:48 | operator@example.invalid | `question.create` | question:73 | | `{"id": 73, "prompt": "Who owns the Leftorium?", "choices": ["Ned Flanders", "Moe", "Apu", "Otto"], "category": …}` |
| 8 | 05:09:49 | operator@example.invalid | `question.delete` | question:73 | `{"id": 73, "prompt": "Who owns the Leftorium?", "choices": […` | |

(Raw console output: `f6/audit-query.txt`. Long JSON values are truncated for width.)

### Reading it

* **Who:** row 3 shows the CLI role change with no user actor, which is correct
  because it was not done through the API. Rows 7–8 are attributed to the operator
  account named in the token.
* **Before/after:** the delete (row 8) keeps the **full deleted question** in
  `before`, so a mistaken delete can be reconstructed from the audit log. Rows 5–6
  show the score moving 0 → 10 → 10.
* **Denied attempts are not audit rows.** The 403 and the 409 changed nothing, so
  they are not in `audit_log`; they are in the request logs (pino, method + path +
  status, credentials redacted) and in OpenTelemetry traces (D10). The audit trail
  records *changes*; the logs record *attempts*.

## Limits

* "Append-only" is enforced by the code, not by the database: there is no trigger
  or role that blocks `UPDATE`/`DELETE` on `audit_log`. Someone with direct database
  credentials (Render-internal) could alter rows. A hardening step would be a
  `BEFORE UPDATE OR DELETE` trigger that raises an error, or a separate database role
  with insert-only rights for the app.
* No retention policy yet: the table grows without limit (about 1 GB/month at 100×
  traffic, see `cost.md`).
* The production audit log is not reproduced here because it contains real users'
  identities; this evidence uses synthetic users only.
