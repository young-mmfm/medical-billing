import "dotenv/config";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "https://demo.openemr.io/openemr";
const PATIENT = process.argv[2] ?? "Belford";

/** Every field quotes the on-screen text it was read from, so a human can
 *  check it without re-driving the browser. An empty quote means the model
 *  found nothing -- which is different from it guessing. */
const cited = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, sourceText: z.string() });

const Demographics = z.object({
  patientName: cited(z.string()),
  dateOfBirth: cited(z.string().nullable()).describe("YYYY-MM-DD"),
  carrier: cited(z.string().nullable()).describe("Primary insurance company"),
  plan: cited(z.string().nullable()),
  policyNumber: cited(z.string().nullable()),
  groupNumber: cited(z.string().nullable()),
});

const Encounters = z.object({
  encounters: z.array(
    z.object({
      date: cited(z.string()).describe("YYYY-MM-DD"),
      provider: cited(z.string().nullable()),
      cptCodes: cited(z.array(z.string())).describe("Procedure codes, e.g. 99202"),
      diagnosisCodes: cited(z.array(z.string())).describe("ICD codes, e.g. 296.20"),
    }),
  ),
});

/**
 * Wait for a page to be ready to read after a click.
 *
 * A click dispatches immediately but the page hasn't responded yet, so without
 * a wait here extract() reads a half-rendered screen.
 *
 * The usual way to wait is waitForLoadState("networkidle") -- block until the
 * network goes quiet. That never resolves on OpenEMR: it polls
 * dated_reminders_counter and background_service/$run forever, so there is
 * always a request in flight. It timed out on 100% of attempts, not
 * intermittently.
 *
 * So instead:
 *   1. domcontentloaded -- fires once when the HTML parses, and ignores the
 *      background polling. The .catch() swallows the timeout you get when the
 *      document was already loaded, which is common here: clicking a tab swaps
 *      iframe content without a document-level navigation, so there is nothing
 *      to wait for. That is not an error.
 *   2. A flat 1500ms pause for the async fragments. OpenEMR loads its chart
 *      panels (stats.php, vitals_fragment.php, ...) via separate XHRs after the
 *      document is ready, so "document parsed" does not mean "insurance panel
 *      has arrived."
 *
 * TODO: that 1500 is a guess and the weakest line in this file. Too short and
 * we extract before a panel lands (fields come back null even though they are
 * visible in the browser -- suspect this first); too long and every call pays
 * the tax. Replace it with a wait for a specific element that proves the panel
 * rendered, e.g.
 *
 *     await page.waitForSelector("<selector that only exists once loaded>");
 *
 * which returns as soon as the content is actually there and fails loudly when
 * it never arrives. It needs one known-stable selector per screen, which is why
 * this minimal version still sleeps instead.
 */
async function settle(page: any) {
  await page.waitForLoadState("domcontentloaded", 15000).catch(() => {});
  await page.waitForTimeout(1500);
}

async function main() {
  const browser = await localBrowser.launch({ headless: !process.env.HEADED });
  const sh = await Stagehand.create({
    browser,
    model: {
      modelName: "anthropic/claude-sonnet-5",
      apiKey: process.env.ANTHROPIC_API_KEY!,
    },
  });
  const page = await sh.browser.context.newPage();

  try {
    // 1. Log in.
    await page.goto(`${BASE}/interface/login/login.php`);
    await sh.act('type "admin" into the username field');
    await sh.act('type "pass" into the password field');
    await sh.act("click the login submit button");
    await settle(page);

    // 2. Find the patient. OpenEMR is a tabbed SPA whose URL never changes and
    //    whose content lives in iframes -- Stagehand's accessibility snapshot
    //    sees into them, so we drive it like any other page. (Deep-linking the
    //    finder URL 400s: every request needs a fresh CSRF token.)
    await sh.act("click the 'Finder' tab in the top navigation bar");
    await settle(page);
    await sh.act(`type "${PATIENT}" into the "Search by any demographics" search box`);
    await page.keyPress("Enter");
    await settle(page);
    await sh.act(`click the row in the patient list table for the patient named ${PATIENT}`);
    await settle(page);

    // 3. Read demographics + insurance.
    const demo = await sh.extract(
      "Extract the patient's name, date of birth, and their PRIMARY insurance: " +
        "carrier, plan name, policy number, group number. For each field quote " +
        "the exact on-screen text you read it from in sourceText. Use null and " +
        "an empty sourceText for anything not shown. Do not guess.",
      Demographics,
    );

    // 4. Read the visit history.
    await sh.act("click the History or Visit History tab for this patient");
    await settle(page);
    const enc = await sh.extract(
      "This is a visit history table. For every encounter row extract the date " +
        "(YYYY-MM-DD), provider, all CPT procedure codes and all ICD diagnosis " +
        "codes. Codes appear like 'CPT4 - 99202' or 'ICD9 - 296.20' -- return " +
        "just the code, e.g. '99202'. Quote the exact cell text in sourceText.",
      Encounters,
    );

    const record = { ...demo.data, ...enc.data };
    mkdirSync("out", { recursive: true });
    writeFileSync("out/simple.json", JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
    console.log("\n  -> out/simple.json");
  } finally {
    // sh.close() disposes Stagehand's resources but leaves Chromium running.
    await sh.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
