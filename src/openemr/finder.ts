import type { Page } from "playwright";
import { urls, type ClinicConfig } from "../config/demo-openemr.js";

export type PatientMatch = {
  /** Internal pid -- what set_pid wants. */
  pid: string;
  /** "Belford, Phil" as shown in the finder. */
  name: string;
  /** As displayed, so format-ambiguous. Only used to disambiguate for a human. */
  dobDisplay: string;
  /** OpenEMR's external/public id. */
  externalId: string;
  /**
   * False when the search term does not appear in the patient's name -- the
   * finder matched a hidden field instead. Absent means it did match.
   */
  nameMatchedSearchTerm?: boolean;
};

/**
 * Find exactly one patient by name.
 *
 * The finder behind the UI is a DataTables endpoint that answers in JSON, so
 * there is nothing to type and no result row to click:
 *
 *   {"iTotalRecords":"32","iTotalDisplayRecords":1,
 *    "aaData":[{"DT_RowId":"pid_1","0":"Belford, Phil","1":"333-444-2222",
 *               "2":"333222333","3":"09/02/1972","4":"1"}]}
 *
 * iTotalDisplayRecords is how many matched the search; iTotalRecords is how
 * many patients exist in total. We want the former.
 *
 * We fetch it from inside the page so the browser's session cookie is used --
 * the endpoint returns the login page to an unauthenticated caller.
 */
export async function findPatientAsync(
  page: Page,
  config: ClinicConfig,
  searchTerm: string,
): Promise<PatientMatch> {
  const url = urls.finderAjax(config.baseUrl, searchTerm);

  const raw = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "same-origin" });
    return { status: res.status, body: await res.text() };
  }, url);

  if (raw.status !== 200) {
    throw new Error(`Patient search failed: HTTP ${raw.status} from the finder endpoint`);
  }
  // An expired session yields the login page's HTML with a 200. Catch that
  // here rather than letting JSON.parse throw something unreadable.
  if (/<html|<!DOCTYPE/i.test(raw.body.slice(0, 200))) {
    throw new Error(
      "Patient search returned HTML instead of JSON -- the session is probably not authenticated.",
    );
  }

  let data: {
    iTotalDisplayRecords?: number | string;
    aaData?: Array<Record<string, string>>;
  };
  try {
    data = JSON.parse(raw.body);
  } catch {
    throw new Error(
      `Patient search returned unparseable JSON: ${raw.body.slice(0, 200)}`,
    );
  }

  const rows = data.aaData ?? [];
  const count = Number(data.iTotalDisplayRecords ?? rows.length);

  if (count === 0 || rows.length === 0) {
    throw new Error(
      `No patient matches ${JSON.stringify(searchTerm)} at ${config.clinic}.`,
    );
  }

  const matches = rows.map(toMatch);

  /**
   * Never auto-pick. Two patients sharing a surname is ordinary, and silently
   * taking the first one bills the wrong person -- a well-formed claim against
   * someone who was never treated. The operator gets the candidates and
   * re-runs with something unambiguous.
   */
  if (matches.length > 1) {
    const list = matches
      .map((m) => `  pid ${m.pid}  ${m.name}  DOB ${m.dobDisplay || "?"}  id ${m.externalId || "?"}`)
      .join("\n");
    throw new Error(
      `${matches.length} patients match ${JSON.stringify(searchTerm)} -- refusing to guess:\n${list}\n` +
        `Re-run with a more specific search term, e.g. "Belford, Phil" or a member id.`,
    );
  }

  const only = matches[0]!;

  /**
   * Report the pick.
   *
   * This step is the one place in the run a human watching a headed browser
   * cannot see. findPatientAsync does not navigate -- it fetches the finder's JSON
   * endpoint from inside the page, so the window sits on the dashboard while
   * the pid is chosen in the background. Yet choosing wrong here is the most
   * consequential error available: every later read is scoped to this pid, so
   * a bad pick produces a complete, well-formed record for the wrong person.
   *
   * The failure paths above already announce themselves. This makes the
   * SUCCESS path visible too, since "it silently picked someone" is exactly
   * what needs checking. Printed for every run, not just headed ones -- it is
   * one line, and it is the line you want in a log when a claim is disputed.
   *
   * On stderr, not stdout: stdout carries the extracted record as JSON, so
   * `pnpm extract Belford > record.json` has to stay pipeable. Progress and
   * diagnostics go to stderr where they do not corrupt it -- same channel as
   * the mismatch warning below.
   */
  console.error(
    `  finder: ${JSON.stringify(searchTerm)} -> pid ${only.pid}  ${only.name || "(name not listed)"}` +
      (only.dobDisplay ? `  DOB ${only.dobDisplay}` : "") +
      (only.externalId ? `  id ${only.externalId}` : "") +
      `  [1 of ${count} match${count === 1 ? "" : "es"}]`,
  );

  /**
   * A single match is not proof it is the right patient.
   *
   * search_any searches across hidden demographics -- address, employer,
   * subscriber details -- not just the name. Searching "Alan" on the demo
   * returns exactly one patient, "Robison, Kendra Nailini", whose displayed
   * name contains neither word; the term matched something not on screen. A
   * lone confident match to the wrong person is the worst shape of failure
   * here, because the ambiguity guard above never fires.
   *
   * So when the term does not appear in the matched name, we still return the
   * patient -- it may well be a deliberate search by phone or member id -- but
   * we say so loudly, and the record carries the mismatch for review.
   */
  if (!nameContains(only.name, searchTerm)) {
    console.warn(
      `  ! ${JSON.stringify(searchTerm)} matched ${JSON.stringify(only.name)} (pid ${only.pid}), ` +
        `whose name does not contain that term.\n` +
        `    OpenEMR's search_any also matches address, phone and employer fields. ` +
        `Confirm this is the intended patient before billing.`,
    );
    only.nameMatchedSearchTerm = false;
  }

  return only;
}

/** Loose containment: "Belford" matches "Belford, Phil"; case-insensitive. */
function nameContains(name: string, term: string): boolean {
  const n = name.toLowerCase();
  return term
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((part) => n.includes(part));
}

/**
 * aaData rows are positional -- sColumns in the request pins the order to
 * name,phone_home,ss,DOB,pubpid, so "0" is the name and "4" the public id.
 * DT_RowId is "pid_<n>".
 */
function toMatch(row: Record<string, string>): PatientMatch {
  const rowId = String(row["DT_RowId"] ?? "");
  const pid = rowId.replace(/^pid_/, "");
  if (!pid) {
    throw new Error(`Finder row has no usable DT_RowId: ${JSON.stringify(row)}`);
  }
  return {
    pid,
    name: stripTags(row["0"] ?? ""),
    dobDisplay: stripTags(row["3"] ?? ""),
    externalId: stripTags(row["4"] ?? ""),
  };
}

/** Finder cells occasionally carry markup (e.g. a bold billing flag). */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}
