# D9: accessibility (axe report and keyboard walkthrough)

**Tools:** axe-core 4.14.1 injected into real Chrome (puppeteer-core), rule tags
`wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice`, at desktop
(1366×900) and mobile (390×844) sizes. The same script performs a keyboard-only
walkthrough. Script: `d9/a11y-check.mjs`. Raw results:
`d9/axe-keyboard-production-before.json`, `d9/axe-keyboard-staging-after.json`.
Lighthouse's accessibility category (also axe-based) was 100 in every D8 run.

## axe results

| | Before (production, `a48b74c`) | After (staging, `0dfba4c`) |
| --- | --- | --- |
| Desktop violations | **1**: `page-has-heading-one` (moderate) | **0** (40 rules pass) |
| Mobile violations | **1**: `page-has-heading-one` (moderate) | **0** (41 rules pass) |
| Needs review (incomplete) | none | none |

**Fix (commit `0dfba4c`):** the app title "TriviaNerd" became the page's single
`<h1>`, styled exactly as before (`frontend/src/components/Header.tsx`). Screen-reader
users can now jump to the page title with heading navigation. A frontend test checks
for exactly one `<h1>`, and changing it back to a `<div>` makes that test fail.

## Keyboard walkthrough (after, desktop)

Tab from the top of the page, no mouse. Each stop records whether a focus indicator
is visible (outline or box-shadow):

| # | Element | Focus visible |
| --- | --- | --- |
| 1 | search box "Search questions" (labelled with `aria-label`) | ✓ |
| 2 | category filter (labelled "Filter by category") | ✓ |
| 3 | "Sign in with Google" | ✓ |
| 4 | "New round" | ✓ |
| 5–13 | the nine questions ("Question 1 …" to "Question 9 …") | ✓ |
| 14–17 | the four answer choices of the active question | ✓ |

17 stops in visual order, with no traps and no unreachable controls.

**Playing with the keyboard only:** Tab to the first answer (14 presses), then
**Enter**. The verdict, "Not quite. The answer is Enforcer on Krusty's show.", appears
in a region with `aria-live="polite"`, so screen readers announce it without moving
focus. Answer buttons expose their state with `aria-pressed`, and the correct answer's
✓ icon has `aria-label="Correct answer"`.

## Other built-in accessibility features (from the code)

* Loading states are `role="status"` with `aria-live="polite"`. Errors are
  `role="alert"`, with a keyboard-reachable **Retry**. The F2 tests check the loading text, the alerts and Retry.
* Colour palette contrast: secondary text `#4a5568` on white is ~7.5:1, and the axe-based
  `color-contrast` audit passes in Lighthouse (score 1).
* Decorative images have `alt=""`. The quiz image is decorative because the question
  text carries the information.

## Limits

Automated tools find only part of real accessibility problems. No screen-reader
session (NVDA or VoiceOver) was recorded. The walkthrough above checks focus order,
visibility and operability, not how the content sounds when read aloud.
