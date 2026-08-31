import type { Locator, Page } from "playwright";
import { selectors, type ClinicConfig } from "../config/demo-openemr.js";
import { parseDate } from "./dates.js";
import { cited, textAsync } from "./read.js";
import type { Cited, Encounter } from "../types.js";

/**
 * Read the Visit History table.
 *
 * Three things in this table will silently corrupt a claim if ignored, so each
 * gets an explicit guard below:
 *
 *  1. The table interleaves tr.docrow rows (attached CCDA documents) among the
 *     tr.encrow rows -- 6 of them among Belford's 2 encounters. They have a
 *     date cell and colspan'd body cells, so a "table tr" selector returns 8
 *     rows and invents six encounters that never happened.
 *  2. The header prints "1-2 of 2", counting encounters only. It is a free
 *     cross-check on whether we read every row.
 *  3. The Billing block is five UNLABELED columns under a single
 *     <th colspan='5'>Billing</th>. Any parser must index them positionally,
 *     so we verify the header shape before trusting the position.
 */
export async function extractEncountersAsync(
  page: Page,
  config: ClinicConfig,
): Promise<Encounter[]> {
  await assertVisitHistoryPageAsync(page);
  const layout = await readColumnLayoutAsync(page);

  const encounters: Encounter[] = [];
  for (const row of await page.locator(selectors.encounterRow).all()) {
    encounters.push(await readRowAsync(row, config, layout));
  }

  await assertCountMatchesHeaderAsync(page, encounters.length);
  return encounters;
}

/**
 * Prove this is the Visit History screen before reading anything off it.
 *
 * The obvious justification -- "it stops us reading history.php" -- is no
 * longer the real one. That page is caught three other ways: the URL is a
 * constant in config so we cannot drift there, openPanelAsync waits for span.title
 * which it does not have, and readColumnLayoutAsync finds no Billing column. This
 * assertion is what makes those failures legible: without it the wrong page
 * reports "no Billing column", sending someone after a billing config problem
 * when they are simply on the wrong screen.
 *
 * What it uniquely catches is a page that is well-formed but still wrong.
 * encounters_report.php and the billing view (encounters.php?billing=1, linked
 * as "To Billing View" from this very page) both render encrow rows under a
 * Billing header. Every other guard passes on those. Only the title separates
 * them, and reading the billing view as if it were Visit History would produce
 * a plausible, well-formed, wrong record.
 */
async function assertVisitHistoryPageAsync(page: Page): Promise<void> {
  // Raw textContent, not the shared textAsync() helper: null (element absent) and
  // "" (element present but empty) mean different things below, and textAsync()
  // deliberately collapses both to "".
  const title = await page
    .locator(selectors.pageTitle)
    .first()
    .textContent()
    .catch(() => null);

  /**
   * Absent and wrong are different failures, so they get different messages.
   * A missing title means the page shape changed -- OpenEMR renamed or moved
   * the element -- and the fix is to update the selector. Telling that person
   * to check they are on the right page sends them somewhere useless.
   */
  if (title === null) {
    throw new Error(
      `Cannot find the page title (${selectors.pageTitle}) on ${page.url()}. ` +
        `The page structure has probably changed -- update selectors.pageTitle ` +
        `rather than assuming this is the wrong screen.`,
    );
  }

  const text = title.trim();
  if (!/visit history/i.test(text)) {
    throw new Error(
      `Expected the Visit History screen but the title reads ${JSON.stringify(text)} ` +
        `(at ${page.url()}). Other OpenEMR screens render encounter-shaped tables ` +
        `-- the billing view and encounters_report.php among them -- and reading ` +
        `one of those as Visit History yields a well-formed but wrong record.`,
    );
  }
}

type ColumnLayout = {
  /** Index of the first Billing cell -- codes live here. Never -1: readColumnLayoutAsync throws. */
  billingStart: number;
  /**
   * -1 when this build does not render the column, which readRowAsync turns into an
   * empty cell rather than a crash. Only Billing is fatal to miss: without it
   * there are no codes, and there is nothing to bill.
   */
  provider: number;
  reason: number;
  insurance: number;
};

/**
 * Work out which cell holds what, from the header rather than by assumption.
 *
 * The reference install renders:
 *   Date | Issue | Reason/Form | Provider | [Billing x5] | Insurance
 *
 * but the Issue column only appears when issue tracking is on, and the Billing
 * block's width is a build option. Hard-coding index 4 for the codes works
 * until a clinic enables one extra column, at which point we would read the
 * Reason text as CPT codes -- or worse, read a dollar amount as one. Deriving
 * the offsets from the header means such a build fails loudly here instead.
 */
async function readColumnLayoutAsync(page: Page): Promise<ColumnLayout> {
  const headers = await page.locator(selectors.encounterHeaderCells).all();

  let index = 0;
  const layout: ColumnLayout = {
    billingStart: -1,
    provider: -1,
    reason: -1,
    insurance: -1,
  };

  for (const th of headers) {
    const label = (await textAsync(th)).toLowerCase();
    const span = Number((await th.getAttribute("colspan")) ?? "1") || 1;

    if (label === "provider") layout.provider = index;
    else if (label.startsWith("reason")) layout.reason = index;
    else if (label === "billing") layout.billingStart = index;
    else if (label === "insurance") layout.insurance = index;

    index += span;
  }

  if (layout.billingStart < 0) {
    throw new Error(
      "Visit History has no Billing column -- cannot locate CPT/ICD codes. " +
        "This build may render billing differently; check the table header.",
    );
  }
  return layout;
}

/**
 * The header prints "1-2 of 2" and counts encounters only -- docrows are
 * excluded from it. If our row count disagrees, we are either dropping
 * encounters (pagination) or picking up rows that are not encounters. Both
 * produce a plausible-looking record, so this throws rather than warns.
 */
async function assertCountMatchesHeaderAsync(page: Page, found: number): Promise<void> {
  const body = await textAsync(page.locator(selectors.encounterTable));
  const m = body.match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/);
  if (!m) return; // Header absent on some builds; the row count stands alone.

  const total = Number(m[3]);
  if (found !== total) {
    throw new Error(
      `Visit History says ${total} encounters but ${found} rows were parsed. ` +
        `Either pagination truncated the list (pagesize=0 should prevent that) ` +
        `or the row selector is matching the wrong rows.`,
    );
  }
}

async function readRowAsync(
  row: Locator,
  config: ClinicConfig,
  layout: ColumnLayout,
): Promise<Encounter> {
  /**
   * The row id encodes both facts we need: "25~30/08/2026" is
   * encounterId~date. We take the id from here but read the date from the
   * visible cell -- they are the same value, and the cell is what a human
   * checking the record would look at.
   */
  const id = (await row.getAttribute("id")) ?? "";
  const [encounterId] = id.split("~");
  if (!encounterId) {
    throw new Error(`Encounter row has an unreadable id: ${JSON.stringify(id)}`);
  }

  // Count once: cellTextAsync is called four times per row and the cell count
  // cannot change between those calls.
  const cells = row.locator("td");
  const cellCount = await cells.count();
  const cellTextAsync = async (i: number): Promise<string> => {
    // i is -1 when this build does not render the column -- an absent column
    // reads as an empty cell rather than throwing.
    if (i < 0 || i >= cellCount) return "";
    return textAsync(cells.nth(i));
  };

  const dateText = await cellTextAsync(0);
  const date: Cited<string> = {
    value: parseDate(dateText, config.dateFormat, `encounter ${encounterId}`),
    sourceText: dateText,
    source: `tr#${id} td:nth-child(1)`,
  };

  const providerText = await cellTextAsync(layout.provider);
  const reasonText = await cellTextAsync(layout.reason);
  const insuranceText = await cellTextAsync(layout.insurance);

  /**
   * Codes live in the first Billing cell as sibling spans:
   *   <span title=''>CPT4 - 99202</span><br>
   *   <span title='Major depressive affective disorder...'>ICD9 - 296.20</span>
   *
   * The prefix names the code set (CPT4, ICD9, ICD10, HCPCS). We split on it
   * so a diagnosis can never be filed as a procedure. Anything we do not
   * recognise is left out of both lists but kept verbatim in sourceText, so it
   * is visible to a human rather than silently dropped.
   */
  const billingCell = cells.nth(layout.billingStart);
  const codeSource = `tr#${id} td:nth-child(${layout.billingStart + 1})`;
  const billingText = await textAsync(billingCell);

  const cpt: string[] = [];
  const icd: string[] = [];
  for (const span of await billingCell.locator("span").all()) {
    const codeText = await textAsync(span);
    const m = codeText.match(/^([A-Za-z0-9]+)\s*-\s*(.+)$/);
    if (!m) continue;
    const set = m[1]!.toUpperCase();
    const code = m[2]!.trim();
    if (set.startsWith("CPT") || set.startsWith("HCPCS")) cpt.push(code);
    else if (set.startsWith("ICD")) icd.push(code);
  }

  return {
    encounterId,
    date,
    provider: cited(providerText, `tr#${id} td:nth-child(${layout.provider + 1})`),
    reason: cited(reasonText, `tr#${id} td:nth-child(${layout.reason + 1})`),
    cptCodes: { value: cpt, sourceText: billingText, source: codeSource },
    diagnosisCodes: { value: icd, sourceText: billingText, source: codeSource },
    insuranceOnVisit: cited(insuranceText, `tr#${id} td:nth-child(${layout.insurance + 1})`),
  };
}

