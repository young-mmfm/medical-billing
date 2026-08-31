import type { DateFormat } from "../config/demo-openemr.js";

/**
 * Parse a displayed date into ISO YYYY-MM-DD under a declared format.
 *
 * The whole point of this module is that it REFUSES to guess.
 *
 * OpenEMR renders dates per site preference. The two HAR captures of the same
 * demo instance disagree -- "2026-08-29" in one, "30/08/2026" in the other --
 * so the format is a property of the install, not of OpenEMR. That makes a
 * date like "01/02/2014" ambiguous on its face: February 1st if the site is
 * DD/MM, January 2nd if MM/DD. Both parse cleanly. Both look right. Only one
 * is the real date of service.
 *
 * An auto-detecting parser (look for a day > 12) works until it meets a
 * patient whose every visit falls in the first twelve days of a month, and
 * then it quietly flips. So: the clinic declares its format in config, we
 * parse strictly under it, and anything that does not match throws.
 *
 * Where OpenEMR gives us a machine-readable value -- demographics cells carry
 * data-value='1972-02-09' -- prefer that and never come here at all.
 */
/**
 * Two shapes, three formats: DD/MM and MM/DD are the same regex and differ
 * only in which capture group is the day, below. That is the whole hazard in
 * one line -- the text cannot tell you which one it is.
 *
 * Keyed by the full DateFormat union so adding a format without a pattern is a
 * compile error rather than a runtime undefined.
 */
const SHAPES: Record<DateFormat, RegExp> = {
  "DD/MM/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  "MM/DD/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  "YYYY-MM-DD": /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
};

export function parseDate(raw: string, format: DateFormat, field: string): string {
  const text = raw.trim();
  if (!text) throw new DateParseError(field, raw, format, "empty");

  const m = text.match(SHAPES[format]);
  if (!m) {
    throw new DateParseError(field, raw, format, "does not match the declared format");
  }

  let year: number, month: number, day: number;
  if (format === "YYYY-MM-DD") {
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if (format === "DD/MM/YYYY") {
    [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  // Range-check before building a Date, because Date happily rolls over:
  // new Date(2014, 12, 32) silently becomes 2015-01-01 rather than failing.
  if (month < 1 || month > 12) {
    throw new DateParseError(field, raw, format, `month ${month} out of range`);
  }
  if (day < 1 || day > 31) {
    throw new DateParseError(field, raw, format, `day ${day} out of range`);
  }
  // Catches Feb 30, Apr 31, and non-leap Feb 29: if the constructed date's
  // parts differ from what went in, the day did not exist in that month.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new DateParseError(field, raw, format, "not a real calendar date");
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Thrown rather than returning null, because a date we cannot read is not a
 * date we can bill. Names the field, the raw text and the configured format,
 * so the fix ("this clinic is MM/DD, not DD/MM") is obvious from the message
 * without re-driving the browser.
 */
export class DateParseError extends Error {
  constructor(
    readonly field: string,
    readonly raw: string,
    readonly format: DateFormat,
    reason: string,
  ) {
    super(
      `Cannot parse ${field} date ${JSON.stringify(raw)} as ${format}: ${reason}. ` +
        `If this clinic renders dates differently, fix dateFormat in its config ` +
        `-- do not guess, a wrong date of service bills the wrong day.`,
    );
    this.name = "DateParseError";
  }
}
