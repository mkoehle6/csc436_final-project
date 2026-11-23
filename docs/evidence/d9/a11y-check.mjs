import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const url = process.argv[2];
const axeSrc = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const out = { url, when: new Date().toISOString(), viewports: {} };
for (const [name, vp] of [["desktop", { width: 1366, height: 900 }], ["mobile", { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".quiz-panel, .status-panel--error", { timeout: 20000 });
  await page.evaluate(axeSrc);
  const res = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
  out.viewports[name] = {
    axeVersion: res.testEngine.version,
    violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(" ")) })),
    passes: res.passes.length, incomplete: res.incomplete.map((v) => v.id), inapplicable: res.inapplicable.length,
  };
  if (name === "desktop") {
    // Keyboard walk: Tab through the page, record each focused element and whether focus is visible.
    const stops = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const s = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.value || "").trim().replace(/\s+/g, " ").slice(0, 50);
        const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
        return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", label, focusVisible: visible };
      });
      if (!s) break;
      if (stops.length && stops[0].label === s.label && stops[0].tag === s.tag) break; // wrapped around
      stops.push(s);
    }
    out.keyboard = stops;
    // Keyboard-only play: Tab to the first answer choice, press Enter, read the announced verdict.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".quiz-panel__choices button", { timeout: 20000 });
    const firstChoice = await page.$eval(".quiz-panel__choices button", (b) => b.textContent.trim());
    let presses = 0, focused = "";
    while (presses < 40 && focused !== firstChoice) {
      await page.keyboard.press("Tab"); presses++;
      focused = await page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
    }
    if (focused !== firstChoice) { out.keyboardAnswer = "answer button not reachable by Tab"; } else {
      await page.keyboard.press("Enter");
      await page.waitForSelector(".quiz-panel__feedback .feedback", { timeout: 15000 });
      const verdict = await page.$eval(".quiz-panel__feedback", (el) => ({ text: el.textContent.trim(), live: el.getAttribute("aria-live") }));
      out.keyboardAnswer = { tabPresses: presses, focused, pressed: "Enter", verdict: verdict.text, announcedVia: "aria-live=" + verdict.live };
    }
  }
  await page.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
