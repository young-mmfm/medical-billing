/**
 * The shape of an extracted encounter record.
 *
 * This is deliberately not a claim -- see docs/product.md. Coding happens in a
 * separate stage so we can redo the coding without re-driving the browser, and
 * redo the extraction without re-arguing the coding.
 */

/**
 * Every field quotes the on-screen text it was read from, so a human can check
 * it without re-driving the browser.
 *
 * This carried over from the Stagehand version, where the point was to catch a
 * model that guessed. Determinism does not make it obsolete -- it makes it
 * cheap and honest. We know exactly which cell we read, so sourceText is the
 * literal text of that cell rather than a model's claim about what it saw. When
 * a payer asks six weeks later why we billed what we billed, this is the
 * answer.
 *
 * A null value with a non-empty sourceText means "the screen said this and we
 * could not parse it" -- different from a null with an empty sourceText, which
 * means "the screen did not show this at all."
 */
export type Cited<T> = {
  value: T;
  /** Verbatim on-screen text this was read from. Empty when nothing was shown. */
  sourceText: string;
  /** Where on the screen it came from -- a CSS selector or element id. */
  source: string;
};

export type Insurance = {
  /** Which policy slot this came from. Only "primary" is extracted today. */
  type: "primary";
  carrier: Cited<string | null>;
  plan: Cited<string | null>;
  policyNumber: Cited<string | null>;
  groupNumber: Cited<string | null>;
  /** ISO YYYY-MM-DD. From the "Primary Insurance from <date> until Present" line. */
  effectiveDate: Cited<string | null>;
};

export type Demographics = {
  patientName: Cited<string>;
  /** ISO YYYY-MM-DD, read from data-value so it is never format-ambiguous. */
  dateOfBirth: Cited<string | null>;
  sex: Cited<string | null>;
  /** OpenEMR's external/public patient id, distinct from the internal pid. */
  externalId: Cited<string | null>;
};

export type Encounter = {
  /** OpenEMR's internal encounter id, from the row id "<id>~<date>". */
  encounterId: string;
  /** ISO YYYY-MM-DD, parsed under the clinic's declared date format. */
  date: Cited<string>;
  provider: Cited<string | null>;
  reason: Cited<string | null>;
  /** Procedure codes, e.g. "99202". Empty array for an uncoded visit. */
  cptCodes: Cited<string[]>;
  /** Diagnosis codes, e.g. "296.20". Empty array for an uncoded visit. */
  diagnosisCodes: Cited<string[]>;
  /** Payer as shown on the visit row, e.g. "Primary: Aekna". */
  insuranceOnVisit: Cited<string | null>;
};

export type EncounterRecord = {
  /** Provenance for the whole record -- see docs/product.md step 5, Persist. */
  extraction: {
    clinic: string;
    baseUrl: string;
    /** OpenEMR's internal patient id. */
    pid: string;
    searchTerm: string;
    /**
     * False when the finder matched on a hidden field (address, phone,
     * employer) rather than the patient's name. Worth a human's eye before
     * billing -- see finder.ts.
     */
    nameMatchedSearchTerm: boolean;
    /** ISO timestamp of when this extraction ran. */
    extractedAt: string;
  };
  demographics: Demographics;
  /** Null when the patient has no primary policy on file. */
  insurance: Insurance | null;
  encounters: Encounter[];
};
