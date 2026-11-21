import { describe, expect, it } from "vitest";
import { cleanName, cleanOccupation, isNamedCharacter } from "../src/lib/characterFilters.js";

/** Cases are real values sampled from The Simpsons API; expected results predicted by hand. */
describe("character filters", () => {
  it.each([
    ["Homer Simpson", true],
    ["Krusty the Clown", true],
    ["Waylon Smithers, Jr.", true],
    ["Pope John Paul II", true],
    ["James L. Brooks (character)", true], // parenthetical note is ignored
    ["Female Unnamed with brown hair and white science coat", false],
    ["Buck-toothed girl", false], // a description, not a name
    ["Unknown", false],
  ])("isNamedCharacter(%j) → %s", (name, expected) => {
    expect(isNamedCharacter(name)).toBe(expected);
  });

  it("strips trailing episode/disambiguation notes from names", () => {
    expect(cleanName("Becky (It's a Mad, Mad, Mad, Mad Marge)")).toBe("Becky");
    expect(cleanName("James L. Brooks (character)")).toBe("James L. Brooks");
    expect(cleanName("Moe Szyslak")).toBe("Moe Szyslak");
  });

  it.each([
    ["Safety Inspector", "Safety Inspector"],
    // two roles glued together without a separator → first role
    [
      "Student at Springfield Elementary SchoolStudent at a religious private school (formerly)",
      "Student at Springfield Elementary School",
    ],
    // comma-separated list → first role
    ["Student at Springfield Elementary School, CTU Agent, Hall-monitor, Member of PETA", "Student at Springfield Elementary School"],
    ["Fourth grade teacher at Springfield Elementary School (formerly)", "Fourth grade teacher at Springfield Elementary School"],
    ["Unknown", null],
    [null, null],
    ["", null],
  ])("cleanOccupation(%j) → %j", (occupation, expected) => {
    expect(cleanOccupation(occupation)).toBe(expected);
  });
});
