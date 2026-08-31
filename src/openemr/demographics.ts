import type { Locator, Page } from "playwright";
import { selectors } from "../config/demo-openemr.js";
import { cited, textAsync } from "./read.js";
import type { Cited, Demographics, Insurance } from "../types.js";

/**
 * Read demographics from the machine-readable attributes, not the display text.
 *
 * OpenEMR renders each demographic cell with both:
 *   <td class='text data' id='text_DOB' data-value='1972-02-09'>09/02/1972</td>
 *
 * 96 fields carry a data-value. Reading it gives us an ISO date regardless of
 * the site's display-format preference, which sidesteps the DD/MM vs MM/DD
 * ambiguity entirely for this panel. The display text still goes into
 * sourceText, so a human checking the record sees what was actually on screen.
 */
export async function extractDemographicsAsync(page: Page): Promise<Demographics> {
  const [fname, lname, dob, sex, pubpid] = await Promise.all([
    readFieldAsync(page, "fname"),
    readFieldAsync(page, "lname"),
    readFieldAsync(page, "DOB"),
    readFieldAsync(page, "sex"),
    readFieldAsync(page, "pubpid"),
  ]);

  /**
   * Build the name from data-value, never from the rendered text.
   *
   * #text_lname is nested INSIDE #text_fname, and the visible surname is
   * printed a second time as a bare text node beside a display:none copy:
   *
   *   <td id='text_fname' data-value='Phil'>Phil
   *     <span><span id='text_lname' style='display: none'>Belford</span>
   *     &nbsp;Belford</span></td>
   *
   * So reading #text_fname's textContent yields "Phil Belford Belford Belford"
   * -- the middle/suffix placeholders and both copies of the surname. The
   * data-value attributes hold exactly one clean value each.
   *
   * Some builds render a single name field instead of fname/lname, so we join
   * whichever parts are present rather than emitting "undefined undefined".
   */
  const nameParts = [fname.value, lname.value].filter(Boolean);
  const patientName: Cited<string> = {
    value: nameParts.join(" "),
    sourceText: nameParts.join(" "),
    source: "#text_fname[data-value] + #text_lname[data-value]",
  };
  if (!patientName.value) {
    throw new Error(
      "Demographics loaded but the patient name is empty -- the panel shape may have changed.",
    );
  }

  return {
    patientName,
    // Already ISO from data-value. Validated rather than parsed: if a build
    // ever puts display text here, we want to know rather than bill it.
    dateOfBirth: assertIso(dob, "date of birth"),
    sex,
    externalId: pubpid,
  };
}

/**
 * Read one demographics cell.
 *
 * Prefers data-value (normalized) and falls back to the visible text for the
 * fields that lack one. An absent element yields a null value with an empty
 * sourceText -- "the screen did not show this" -- which is deliberately
 * distinct from a null with text, meaning "shown but unreadable."
 */
async function readFieldAsync(page: Page, name: string): Promise<Cited<string | null>> {
  const sel = selectors.demoField(name);
  const el = page.locator(sel).first();
  const source = sel;

  if ((await el.count()) === 0) {
    return { value: null, sourceText: "", source };
  }

  const [dataValue, display] = await Promise.all([
    el.getAttribute("data-value"),
    textAsync(el),
  ]);

  const machine = (dataValue ?? "").trim();
  const value = machine || display;

  /**
   * sourceText is what a human would check against the screen, so it should be
   * the visible text -- except where the element wraps other fields (the
   * name cell nests #text_lname inside #text_fname, so its textContent is a
   * run-together of several fields plus a hidden duplicate). When the visible
   * text merely surrounds the machine value with other content, quote the
   * machine value instead: a citation nobody can verify is worse than none.
   */
  const isNested = !!machine && display !== machine && display.includes(machine);
  return { value: value || null, sourceText: isNested ? machine : display, source };
}

/** data-value dates are documented as ISO; verify rather than trust. */
function assertIso(field: Cited<string | null>, label: string): Cited<string | null> {
  if (field.value && !/^\d{4}-\d{2}-\d{2}$/.test(field.value)) {
    throw new Error(
      `Expected an ISO ${label} from data-value but got ${JSON.stringify(field.value)}. ` +
        `This build may not populate data-value the way the reference install does.`,
    );
  }
  return field;
}

/**
 * Read the primary insurance policy.
 *
 * Unlike demographics, this panel has no data-value attributes -- it is
 * label/value pairs inside #primary:
 *
 *   <div class="list-group-item ..."><strong>Policy Number:</strong>
 *     <span class="text-right text-monospace">555</span></div>
 *
 * So we match on the label text, which survives the columns being reordered or
 * a field being added. Returns null when the patient has no policy on file --
 * #primary is absent entirely in that case, which is a legitimate state (a
 * self-pay patient), not an error.
 *
 * Scope is the primary policy only. Patients with secondary/tertiary coverage
 * have additional panes (#secondary, #tertiary) that this version does not read.
 */
export async function extractInsuranceAsync(page: Page): Promise<Insurance | null> {
  const pane = page.locator(selectors.insurancePrimary);
  if ((await pane.count()) === 0) return null;

  /**
   * A patient can have several historical policies, paginated as #primary-1,
   * #primary-2 ... with the inactive ones carrying d-none. Take the visible
   * one: that is the coverage in effect, and billing an expired policy is a
   * guaranteed denial.
   */
  const panes = pane.locator(selectors.insurancePane);
  const paneCount = await panes.count();
  let active = panes.first();
  for (let i = 0; i < paneCount; i++) {
    const candidate = panes.nth(i);
    const cls = (await candidate.getAttribute("class")) ?? "";
    if (!cls.includes("d-none")) {
      active = candidate;
      break;
    }
  }

  // An empty pane means the tab exists but holds no policy.
  const carrierText = await textAsync(active.locator(selectors.insuranceCarrier));
  const [plan, policyNumber, groupNumber] = await Promise.all([
    readLabeledAsync(active, "Plan Name"),
    readLabeledAsync(active, "Policy Number"),
    readLabeledAsync(active, "Group Number"),
  ]);

  if (!carrierText && !plan.value && !policyNumber.value) return null;

  return {
    type: "primary",
    carrier: cited(
      carrierText,
      `${selectors.insurancePrimary} ${selectors.insuranceCarrier}`,
    ),
    plan,
    policyNumber,
    groupNumber,
    effectiveDate: await readEffectiveDateAsync(active),
  };
}

/** Find a list-group row by its <strong> label and return the value beside it. */
async function readLabeledAsync(
  scope: Locator,
  label: string,
): Promise<Cited<string | null>> {
  const source = `${selectors.insurancePrimary} ${selectors.insuranceItem} :text("${label}")`;

  for (const item of await scope.locator(selectors.insuranceItem).all()) {
    // Tolerant match: the markup writes "Policy Number:" with a trailing
    // colon, callers pass it without, and a build could differ in casing.
    const strong = await textAsync(item.locator("strong"));
    if (strong.replace(/:$/, "").toLowerCase() !== label.toLowerCase()) continue;
    return cited(await textAsync(item.locator("span")), source);
  }
  return cited("", source);
}

/**
 * Pull the effective date out of the pane's prose header:
 *   "Primary Insurance from 08/02/2012 until Present"
 *
 * Kept as displayed rather than parsed to ISO. It is shown in the site's date
 * format, so it carries the same DD/MM vs MM/DD ambiguity as the visit dates,
 * and unlike those it is not something we bill on -- so we record it verbatim
 * instead of asserting a format we have no independent confirmation of.
 */
async function readEffectiveDateAsync(scope: Locator): Promise<Cited<string | null>> {
  const source = `${selectors.insurancePrimary} ${selectors.insuranceEffective}`;
  const line = await textAsync(scope.locator(selectors.insuranceEffective));
  const m = line.match(/from\s+(\S+)/i);
  return { value: m ? m[1]! : null, sourceText: line, source };
}
