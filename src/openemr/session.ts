import { chromium, type Browser, type Page } from "playwright";
import { urls, type ClinicConfig } from "../config/demo-openemr.js";

/**
 * Log in and hand back a page whose session cookie is good for direct reads.
 *
 * Login is a single form POST -- no CSRF token, no site selector, no 2FA:
 *
 *   POST /interface/main/main_screen.php?auth=login&site=default
 *   new_login_session_management=1&languageChoice=1&authUser=..&clearPass=..
 *   -> 302 /interface/main/tabs/main.php?token_main=<40 chars>
 *
 * We fill and submit the real form rather than crafting the POST ourselves, so
 * any hidden field the install adds comes along for free.
 *
 * Note we never touch the token_main in the redirect. It scopes the SPA's tab
 * state; the panel URLs we read afterwards authenticate on the session cookie
 * alone. Confirmed in the HAR: demographics.php, encounters.php and
 * history.php were all bare GETs with no csrf_token_form.
 */
export async function loginAsync(
  config: ClinicConfig,
  opts: { headed?: boolean; slowMo?: number } = {},
): Promise<{ browser: Browser; page: Page }> {
  /**
   * slowMo pauses before every Playwright action -- click, fill, navigation --
   * so a person watching in headed mode can actually see what happened. It is
   * a debugging aid only: it multiplies wall-clock time by roughly the pause
   * times the number of actions, so it is off unless asked for.
   *
   * Note it does NOT slow down reads. Most of this extraction is textContent()
   * and getAttribute(), which are not "actions", so the panels will still
   * appear and be scraped in one jump. What you get to watch is the login
   * typing and each navigation landing -- which is the part worth verifying by
   * eye. Use SETTLE_MS below if you also want the rendered panels to linger.
   */
  const browser = await chromium.launch({
    headless: !opts.headed,
    slowMo: opts.slowMo ?? 0,
  });
  const page = await browser.newPage();

  try {
    await page.goto(urls.login(config.baseUrl), { waitUntil: "domcontentloaded" });

    await page.fill('input[name="authUser"]', config.credentials.username);
    await page.fill('input[name="clearPass"]', config.credentials.password);

    await Promise.all([
      page.waitForURL(/main_screen\.php|tabs\/main\.php/, { timeout: 30_000 }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);

    await assertLoggedInAsync(page, config);
    return { browser, page };
  } catch (err) {
    // Do not leak a Chromium process when login fails -- this throws, so the
    // caller never gets a handle to close.
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Confirm we are actually authenticated.
 *
 * OpenEMR answers bad credentials with 200 and the login form again, not with
 * an error status. Without this check the failure surfaces much later as an
 * empty patient search, which reads like "no such patient" -- a wrong answer
 * wearing the costume of a right one.
 */
async function assertLoggedInAsync(page: Page, config: ClinicConfig): Promise<void> {
  const url = page.url();
  if (/login\.php|login_screen\.php/.test(url)) {
    const error = await page
      .locator(".alert-danger, .error, #error")
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(
      `Login failed for ${config.credentials.username} at ${config.baseUrl}` +
        (error ? `: ${error.trim()}` : " (still on the login page)"),
    );
  }
}

/**
 * Navigate to a panel URL and wait for proof it rendered.
 *
 * The obvious wait -- waitForLoadState("networkidle") -- never resolves on
 * OpenEMR. It polls dated_reminders_counter and background_service/$run
 * forever, so a request is always in flight. It timed out on 100% of attempts
 * in the Stagehand version, not intermittently.
 *
 * The previous fix was domcontentloaded plus a flat 1500ms sleep, which its own
 * comment called the weakest line in the file: too short and you read a
 * half-rendered screen and get nulls for fields that are plainly visible, too
 * long and every call pays the tax. Navigating directly to panel URLs makes the
 * sleep unnecessary -- each panel is its own document, so we can wait on a
 * specific element that only exists once the content is there. It returns as
 * soon as the content lands and fails loudly when it never does.
 */
export async function openPanelAsync(
  page: Page,
  url: string,
  readySelector: string,
  what: string,
): Promise<void> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  if (response && response.status() >= 400) {
    throw new Error(`${what} returned HTTP ${response.status()} for ${url}`);
  }
  if (/login\.php|login_screen\.php/.test(page.url())) {
    throw new Error(`Session expired while loading ${what} -- redirected to login`);
  }

  await page.waitForSelector(readySelector, { timeout: 30_000 }).catch(() => {
    throw new Error(
      `${what} loaded but ${JSON.stringify(readySelector)} never appeared. ` +
        `The page may have changed shape, or this patient's panel may be empty.`,
    );
  });

  /**
   * Optional hold so a human watching can read the panel before we scrape it
   * and move on. Extraction itself is all reads, which slowMo does not touch,
   * so without this the demographics screen flashes past in well under a
   * second.
   *
   * This is the one deliberate sleep in the codebase and it is inert unless
   * SETTLE_MS is set -- it must never become the load-bearing wait that the
   * old settle() was. Correctness still rests entirely on the waitForSelector
   * above.
   */
  const hold = Number(process.env.SETTLE_MS ?? 0);
  if (hold > 0) await page.waitForTimeout(hold);
}
