import type { Locator } from "playwright";
import type { Cited } from "../types.js";

/**
 * Shared DOM-reading glue for the panel extractors.
 *
 * Both demographics.ts and encounters.ts read text out of locators and wrap it
 * in Cited. Before this module they each spelled that four different ways --
 * some collapsing interior whitespace, some only trimming the ends -- so
 * whether a citation came back readable depended on which file you were in.
 * The insurance effective-date citation was landing in the fixtures as
 * "Primary Insurance\n                from 2012-02-08                 until
 * Present", which is not something a human can check against a screen.
 */

/**
 * textContent of the first match, whitespace-collapsed. "" when absent.
 *
 * Collapsing runs of whitespace to single spaces is the right default for
 * every read here: the source is indented HTML, so the raw text is full of
 * newlines and long indentation runs that are invisible on screen. sourceText
 * is meant to be what a human sees, and a citation nobody can verify is worse
 * than none.
 */
export async function textAsync(locator: Locator): Promise<string> {
  const raw = await locator.first().textContent().catch(() => null);
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Wrap already-read text as a citation.
 *
 * Empty text becomes a null value with an empty sourceText -- "the screen did
 * not show this" -- which types.ts documents as deliberately distinct from a
 * null value with text, meaning "shown but unreadable". Keeping that invariant
 * in one place is the point: it was previously reconstructed inline in six
 * places, and one of them drifting would be invisible until a payer asked.
 */
export function cited(text: string, source: string): Cited<string | null> {
  return { value: text || null, sourceText: text, source };
}
