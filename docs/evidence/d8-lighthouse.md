# D8: Lighthouse before and after one improvement

**Tool:** Lighthouse 13.6.0 CLI, default (mobile) profile, headless Chrome, run from
the student's machine. **Target:** `https://trivia-staging.burnscodev.com/`. Before =
commit `a48b74c` (frontend); after = commit `0dfba4c`. Each side was run three times,
because every page load gets a random round of questions (some have no image).

Full reports: `d8/lighthouse-staging-before-run1.html`,
`d8/lighthouse-staging-after-run1.html`. A production baseline with the same result
is in `d8/lighthouse-production-before-mobile.html`.

## The problem found

The baseline mobile run scored **Performance 89**, held back by **Cumulative Layout
Shift 0.205** (good is ≤ 0.1). Lighthouse's `layout-shifts` audit named the culprit:
`section.app-content` shifted when `img.quiz-panel__image` loaded. `unsized-images`
flagged the same image. The image box had `max-height` but no reserved height, so the
panel grew when the character picture arrived and pushed the answer buttons down.
A player aiming at an answer could hit the wrong one.

## The improvement (one change)

`frontend/src/App.css` and `frontend/src/components/QuizPanel.tsx`, commit `0dfba4c`:
* The image box has a fixed height, `min(320px, 60vw)`, with `object-fit: contain`.
  The space is reserved before the image arrives, and every picture fits inside it.
* The "Image unavailable" placeholder uses the same box. It used to be 220 px, so
  falling back to it shifted the layout too.
* The `<img>` has `width`/`height` attributes, which is what `unsized-images` checks.

## Results (mobile)

| Run | Quiz image loaded? | Performance | CLS | LCP | FCP | `unsized-images` |
| --- | --- | --- | --- | --- | --- | --- |
| before 1 | yes | 89 | 0.205 | 2.0 s | | fail (0.5) |
| before 2 | yes | 100 | 0.041 | 1.7 s | | fail (0.5) |
| before 3 | yes | 89 | 0.205 | 2.0 s | | fail (0.5) |
| **after 1** | yes | **100** | **0** | 1.8 s | 1.0 s | pass |
| after 2 | no (question without image) | 99 | 0 | 1.8 s | 0.8 s | pass |
| **after 3** | yes | **100** | **0** | 1.8 s | 0.8 s | pass |

**Median: Performance 89 → 100, CLS 0.205 → 0.** The fair comparison is runs where an
image loaded (after 1 and 3): CLS is 0 in both. The one good "before" run (before 2)
is explained by timing: when the image arrives before the first render settles, the
shift is small. The bug was intermittent, and the fix removes it in every case.
Accessibility stayed at 100, Best Practices at 96 and SEO at 91–92.

## Not changed (noted)

* **Best Practices 96: `errors-in-console`.** This is the browser logging a **401 from
  `POST /auth/token`** for a visitor who is not signed in. That is how the app learns
  "not signed in" (F7–F9). It is expected and handled, not a failure. A 204 for
  "no session" would silence it, at the cost of changing the auth contract; not done.
* **SEO 92: `meta-description` missing.** Easy to add; left out so this comparison
  measures exactly one change.
