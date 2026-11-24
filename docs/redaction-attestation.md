# Redaction attestation (Q3, hard gates)

> **Draft for the student to verify, complete and sign.**

## Secrets: exposures and remediation

| Date       | What                                                           | How exposed                                        | Remediation                                                                      | Live secret exposed now? |
| ---------- | -------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------ |
| 2026-11-20 | Google OAuth client secret (local dev client)                  | pasted into the AI chat                            | rotated the same day before further use; old secret deleted                      | No                       |
| 2026-11-20 | Google OAuth client secret (local dev client, second)          | selected in the editor (sent to the AI as context) | rotated; old secret deleted                                                      | No                       |
| 2026-11-21 | First staging and production signing keys (`AUTH_PRIVATE_JWK`) | selected in the editor                             | regenerated before use; deployed keys are different (`kid` checked from outside) | No                       |

Never exposed: Render deploy hooks (GitHub secrets only), Grafana token (Render env
only), production Google client secrets (Render env only), database credentials
(Render-internal).

Controls: `.env` git-ignored; secret scans before every commit (Google secret
prefixes, private JWK fields, deploy-hook URLs, credentialed database URLs);
pino redacts `Authorization`, `Cookie` and `Set-Cookie`; tokens never written to
logs; the access token in the browser is kept in memory only.

## Secrets provided to the instructor (on request)

At the instructor's request, the live configuration values (Google OAuth client
secrets, signing keys, database URLs, Grafana token, Render deploy hooks) were
provided **privately through the school's submission site**, in a separate file that
is not part of the repository, the evidence or any public surface. After grading,
every one of them is rotated (runbook §10), so the submitted copies stop working.

## Personal data

- The app stores real Google identities (email, display name) for signed-in users only;
  public surfaces (leaderboard, live events, MCP tools) use synthetic nicknames.
- Screenshots and recordings: the "Signed in as …" line on consent screens, browser
  profile pictures, email addresses and tokens are blurred / removed before submission.

## Attestation

I have reviewed the repository, images, logs, screenshots, recordings and client bundle
submitted with this project. No live secret appears in them (the separate, private
configuration file requested by the instructor excepted, see above), and all real personal data
has been redacted or replaced with synthetic data.

Signed: **Mark Koehler** &nbsp;&nbsp; Date: **11-23-26**
