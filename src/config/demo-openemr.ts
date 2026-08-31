/**
 * Per-clinic configuration.
 *
 * docs/product.md calls for "per-clinic / per-EMR navigation instructions,
 * since builds and templates differ between installs of the same EMR." Two
 * OpenEMR installs can differ in date format, which billing columns are
 * enabled, and which encounter forms a template uses -- so these values are
 * data, not code. One driver, many configs; otherwise we fork the script per
 * clinic and every fix has to be applied N times.
 *
 * Everything here was verified against the two HAR captures of demo.openemr.io
 * (gitignored, ~10MB each). Where a value is a guess rather than an
 * observation, it says so.
 */

/** Supported display formats. Deliberately a closed set -- see dates.ts. */
export type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

export type ClinicConfig = {
  /** Short name, used in output provenance. */
  clinic: string;
  baseUrl: string;
  credentials: { username: string; password: string };
  /**
   * How this install renders dates in visit history.
   *
   * This MUST be declared, never inferred, and it WILL change under you.
   *
   * Observed on this one instance across three days: "2026-08-29" (first HAR),
   * "30/08/2026" (second HAR), then "2026-08-31" again the next morning. It is
   * a per-site/per-user preference and someone keeps flipping it. Encounter 5
   * rendered as "01/02/2014" one day and "2014-02-01" the next -- the same
   * visit, the same install.
   *
   * That is exactly why this is asserted rather than sniffed: "01/02/2014" is
   * Feb 1st under DD/MM and Jan 2nd under MM/DD, both parse, both look right,
   * and only one is the real date of service. A wrong date of service is a
   * clean, plausible, well-formed claim for the wrong day.
   *
   * When the extraction stops with a DateParseError naming this field, the
   * clinic changed its display preference -- confirm the new format on screen
   * and update this value. Do not widen the parser to accept both.
   *
   * Demographics dates avoid this entirely -- they carry a machine-readable
   * data-value in ISO. Only the visit-history table needs parsing.
   */
  dateFormat: DateFormat;
};

export const DEMO_OPENEMR: ClinicConfig = {
  clinic: "demo-openemr",
  baseUrl: "https://demo.openemr.io/openemr",
  // The public demo's well-known shared credentials. A real clinic's go in the
  // environment; this is a public sandbox with fake patients.
  credentials: {
    username: process.env.OPENEMR_USER ?? "admin",
    password: process.env.OPENEMR_PASS ?? "pass",
  },
  dateFormat: "YYYY-MM-DD",
};

/**
 * URL builders.
 *
 * OpenEMR is a tabbed SPA whose top-level URL never changes and whose panels
 * live in Knockout-bound iframes. Rather than clicking tabs and waiting for
 * frames to swap, we navigate straight to each panel's own URL -- every one of
 * these loads as a standalone document needing nothing but the session cookie.
 * Confirmed in the HAR: demographics.php, encounters.php and history.php were
 * all plain GETs with no csrf_token_form.
 */
export const urls = {
  login: (base: string) => `${base}/interface/login/login.php`,

  /** The login form posts here. Returns 302 to tabs/main.php on success. */
  loginPost: (base: string) =>
    `${base}/interface/main/main_screen.php?auth=login&site=default`,

  /**
   * Patient search. A DataTables endpoint that answers in JSON:
   *   {"iTotalRecords":"32","iTotalDisplayRecords":1,
   *    "aaData":[{"DT_RowId":"pid_1","0":"Belford, Phil",...}]}
   *
   * The DataTables plumbing parameters (sEcho/iColumns/mDataProp_N/...) are
   * required -- the endpoint 500s without them. sColumns fixes the column
   * order, so aaData["0"] is reliably the name and ["4"] the public id.
   */
  finderAjax: (base: string, search: string) => {
    const p = new URLSearchParams({
      search_any: search,
      sEcho: "1",
      iColumns: "5",
      sColumns: "name,phone_home,ss,DOB,pubpid",
      iDisplayStart: "0",
      // 100, not the UI's 10: we need every match to detect ambiguity
      // reliably rather than only the first page of it.
      iDisplayLength: "100",
      sSearch: "",
      bRegex: "false",
      iSortCol_0: "0",
      sSortDir_0: "asc",
      iSortingCols: "1",
      searchType: "false",
    });
    for (let i = 0; i < 5; i++) {
      p.set(`mDataProp_${i}`, String(i));
      p.set(`sSearch_${i}`, "");
      p.set(`bRegex_${i}`, "false");
      p.set(`bSearchable_${i}`, "true");
      p.set(`bSortable_${i}`, "true");
    }
    return `${base}/interface/main/finder/dynamic_finder_ajax.php?${p}`;
  },

  /** Sets the session's active patient as a side effect of loading. */
  demographics: (base: string, pid: string) =>
    `${base}/interface/patient_file/summary/demographics.php?set_pid=${encodeURIComponent(pid)}`,

  /**
   * Visit History.
   *
   * pagesize=0 means ALL. The UI defaults to 20, which would silently drop
   * encounters for any patient with a longer history -- the failure would look
   * exactly like a patient who simply had fewer visits.
   *
   * NOT to be confused with history.php, which is the "History" tab: family
   * history, lifestyle, risk factors. It contains no encounters at all -- no
   * encrow, no CPT, no ICD. Reading it yields an empty encounter list that
   * looks like a legitimately empty chart.
   */
  encounters: (base: string) =>
    `${base}/interface/patient_file/history/encounters.php?billing=0&issue=0&pagesize=0&pagestart=0`,
};

/**
 * Selectors, kept together so a clinic whose build differs can be re-pointed
 * without touching extraction logic.
 */
export const selectors = {
  /**
   * Demographics cells expose a normalized machine value beside the display
   * text:  <td id='text_DOB' data-value='1972-02-09'>09/02/1972</td>
   * 96 fields carry one. Reading data-value sidesteps display formatting.
   */
  demoField: (name: string) => `#text_${name}`,

  /** Primary insurance tab pane. Absent entirely when no policy is on file. */
  insurancePrimary: "#primary",
  /** Panes within it: #primary-1, #primary-2 for multiple historical policies. */
  insurancePane: ".tab-pagination-pane",
  insuranceCarrier: ".insurer address strong",
  /** Label/value rows: <strong>Policy Number:</strong> <span>555</span> */
  insuranceItem: ".list-group-item",
  /** Prose line: "Primary Insurance from 08/02/2012 until Present". */
  insuranceEffective: ".text-primary",

  /**
   * Encounter rows. MUST be .encrow specifically: the same table interleaves
   * tr.docrow rows for attached documents (6 CCDA rows among Belford's 2
   * encounters), which have a date cell but no encounter data. A plain
   * "table tr" selector returns 8 rows and silently invents encounters.
   */
  encounterRow: "tr.encrow",
  /** Header cells -- readColumnLayoutAsync derives column positions from these. */
  encounterHeaderCells: "thead th",
  /** Outer container; its "1-2 of 2" text cross-checks the row count. */
  encounterTable: "#encounters",
  /** "Visit History" -- proves we are not on history.php. */
  pageTitle: "span.title",
};
