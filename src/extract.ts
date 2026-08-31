import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { DEMO_OPENEMR, urls, selectors } from "./config/demo-openemr.js";
import { loginAsync, openPanelAsync } from "./openemr/session.js";
import { findPatientAsync } from "./openemr/finder.js";
import { extractDemographicsAsync, extractInsuranceAsync } from "./openemr/demographics.js";
import { extractEncountersAsync } from "./openemr/encounters.js";
import type { EncounterRecord } from "./types.js";

/**
 * Deterministic structured extraction from OpenEMR.
 *
 * Replaces the Stagehand spike (src/stagehand_demo.ts), which paid a model to
 * re-derive the same navigation on every run. For RCM we onboard a clinic once
 * and then run the same extraction thousands of times, so the navigation is
 * fixed and belongs in code; only per-clinic differences belong in config.
 *
 * Every read here is a direct URL. OpenEMR is a tabbed SPA whose top-level URL
 * never changes and whose panels live in Knockout-bound iframes, but each panel
 * is also its own document that authenticates on the session cookie alone -- so
 * we skip the tabs, the iframes and the waiting entirely.
 *
 *   pnpm extract Belford
 *   pnpm extract Belford --verify            compare against the committed fixture
 *   pnpm extract Belford --update-snapshot   rewrite that fixture
 *
 * To watch it work, in a visible browser:
 *
 *   HEADED=1 pnpm extract Belford                     real time -- too fast to follow
 *   HEADED=1 SLOW_MO=500 pnpm extract Belford         half a second before each action
 *   HEADED=1 SLOW_MO=500 SETTLE_MS=3000 pnpm extract Belford
 *                                                     ... and hold 3s on each panel
 *
 * SLOW_MO paces the actions (typing, clicking, navigating). SETTLE_MS holds
 * each panel on screen after it renders, because the extraction itself is all
 * reads -- which SLOW_MO does not pace -- so a panel would otherwise be
 * scraped and gone in a blink.
 */

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const searchTerm = args.find((a) => !a.startsWith("--")) ?? "Belford";

const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runName = `${slug(searchTerm)}-${runStamp}`;
const stdoutPath = `cli_outputs/${runName}.stdout.json`;
const logPath = `cli_outputs/${runName}.log`;

const stdoutChunks: string[] = [];
const logChunks: string[] = [];

/**
 * Mirror both streams to cli_outputs/ so a run's execution history survives it,
 * including a run that throws. The files are written by flushCliOutputs on
 * every exit path.
 */
function emit(line: string): void {
  stdoutChunks.push(line);
  console.log(line);
}

function note(line: string): void {
  logChunks.push(line);
  console.error(line);
}

function flushCliOutputs(): void {
  mkdirSync("cli_outputs", { recursive: true });
  writeFileSync(stdoutPath, stdoutChunks.join("\n"));
  writeFileSync(logPath, logChunks.join("\n"));
  console.error(`\n  cli outputs:\n    ${stdoutPath}\n    ${logPath}`);
}

async function mainAsync(): Promise<void> {
  const config = DEMO_OPENEMR;
  const { browser, page } = await loginAsync(config, {
    headed: !!process.env.HEADED || !!process.env.SLOW_MO,
    slowMo: Number(process.env.SLOW_MO ?? 0),
  });

  try {
    // 1. Find the patient. The finder is a JSON endpoint, so there is nothing
    //    to type and no result row to click. It refuses to pick when more than
    //    one patient matches.
    const match = await findPatientAsync(page, config, searchTerm);

    // 2. Demographics. Loading this URL also sets the session's active patient,
    //    which is what makes the encounters read below resolve to this person.
    await openPanelAsync(
      page,
      urls.demographics(config.baseUrl, match.pid),
      selectors.demoField("fname"),
      "demographics",
    );
    const demographics = await extractDemographicsAsync(page);
    const insurance = await extractInsuranceAsync(page);

    // 3. Visit History. extractEncountersAsync asserts the page title.
    await openPanelAsync(
      page,
      urls.encounters(config.baseUrl),
      selectors.pageTitle,
      "visit history",
    );
    const encounters = await extractEncountersAsync(page, config);

    const record: EncounterRecord = {
      extraction: {
        clinic: config.clinic,
        baseUrl: config.baseUrl,
        pid: match.pid,
        searchTerm,
        nameMatchedSearchTerm: match.nameMatchedSearchTerm !== false,
        extractedAt: new Date().toISOString(),
      },
      demographics,
      insurance,
      encounters,
    };

    mkdirSync("out", { recursive: true });
    const outPath = `out/${slug(searchTerm)}.json`;
    const json = JSON.stringify(record, null, 2);
    writeFileSync(outPath, json);

    /**
     * stdout carries the record and nothing else, so
     * `pnpm extract Belford > record.json` yields parseable JSON. Every
     * human-facing line -- the file pointer, the summary, the finder's pick,
     * snapshot results -- goes to stderr.
     */
    emit(json);
    note(`\n  -> ${outPath}`);
    note(summary(record));

    const fixture = `fixtures/${slug(searchTerm)}.json`;
    if (flags.has("--update-snapshot")) {
      mkdirSync("fixtures", { recursive: true });
      writeFileSync(fixture, JSON.stringify(stable(record), null, 2));
      note(`  -> wrote snapshot ${fixture}`);
    } else if (flags.has("--verify")) {
      verifySnapshot(record, fixture);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

/** One line a human can sanity-check at a glance. */
function summary(r: EncounterRecord): string {
  const coded = r.encounters.filter(
    (e) => e.cptCodes.value.length || e.diagnosisCodes.value.length,
  ).length;
  return (
    `\n  ${r.demographics.patientName.value} (pid ${r.extraction.pid})` +
    `  DOB ${r.demographics.dateOfBirth.value ?? "?"}` +
    `\n  insurance: ${r.insurance?.carrier.value ?? "none on file"}` +
    `\n  encounters: ${r.encounters.length} (${coded} coded)`
  );
}

/**
 * Strip the fields that legitimately change between runs, so a snapshot diff
 * shows real drift rather than the clock.
 */
function stable(r: EncounterRecord): unknown {
  const { extractedAt, ...extraction } = r.extraction;
  return { ...r, extraction };
}

/**
 * Compare against the committed fixture and report WHICH fields moved.
 *
 * demo.openemr.io is a shared public sandbox -- other people edit the same
 * patients. The provider on encounter 5 already changed between our two HAR
 * captures (Smith, Billy -> Baptiste, John). So drift here is usually the demo
 * moving, not a bug, and the fix is normally --update-snapshot. A raw dump
 * would be unreadable and would train everyone to ignore it; a field list is
 * something you can actually judge.
 */
function verifySnapshot(record: EncounterRecord, fixturePath: string): void {
  if (!existsSync(fixturePath)) {
    throw new Error(
      `No snapshot at ${fixturePath}. Create it with --update-snapshot once you ` +
        `have eyeballed the extracted record above.`,
    );
  }

  const expected = JSON.parse(readFileSync(fixturePath, "utf8"));
  const diffs = diff(expected, stable(record), "");

  if (diffs.length === 0) {
    note(`\n  snapshot OK -- matches ${fixturePath}`);
    return;
  }

  note(`\n  snapshot MISMATCH vs ${fixturePath} (${diffs.length} field(s)):`);
  for (const d of diffs.slice(0, 40)) note(`    ${d}`);
  if (diffs.length > 40) note(`    ... and ${diffs.length - 40} more`);
  note(`\n  If the demo data legitimately changed, re-run with --update-snapshot.`);
  process.exitCode = 1;
}

/** Recursive field-level diff, reporting dotted paths. */
function diff(a: unknown, b: unknown, path: string): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    /**
     * On a length mismatch, report the length and stop. Recursing over the
     * longer array would emit an "expected <x>, got undefined" line for every
     * field of every missing element -- a dozen lines restating one fact,
     * which is the unreadable dump this function exists to avoid.
     */
    if (a.length !== b.length) {
      return [`${path}: ${a.length} item(s) expected, got ${b.length}`];
    }
    return a.flatMap((_, i) => diff(a[i], b[i], `${path}[${i}]`));
  }
  if (isRecordValue(a) && isRecordValue(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diff(a[k], b[k], path ? `${path}.${k}` : k));
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    return [`${path}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`];
  }
  return [];
}

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patient";
}

mainAsync()
  .then(() => {
    flushCliOutputs();
    process.exit(process.exitCode ?? 0);
  })
  .catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    note(`\n${message}`);
    flushCliOutputs();
    process.exit(1);
  });
