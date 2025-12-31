import { chromium } from "playwright";

/**
 * Returns a random lowercase english string, letters only (a-z).
 * Example: "kqmp"
 */
function randomLetters(len = 4) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Returns today's date in ddmmyy format.
 * Example: 31/12/2025 => "311225"
 */
function ddmmyyToday() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

/**
 * Small helper: sleep/delay in async flows
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const MAIL_TM_BASE = "https://api.mail.tm";

/**
 * Fetch helper that:
 * - sends JSON when body is provided
 * - returns JSON on success
 * - throws a readable error on failure
 */
async function fetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  if (!res.ok) {
    const details = json ? JSON.stringify(json) : text;
    throw new Error(`HTTP ${res.status} ${res.statusText} on ${method} ${url}\n${details}`);
  }

  return json;
}

/**
 * Create a fresh mailbox on mail.tm (new address each run).
 */
async function createMailTmMailbox() {
  const domains = await fetchJson(`${MAIL_TM_BASE}/domains`);
  const list = domains?.["hydra:member"] || [];
  const active = list.find((d) => d?.isActive && d?.domain);
  if (!active?.domain) throw new Error("mail.tm: No active domain returned from /domains");

  const domain = active.domain;

  const mailboxPassword = `Aa${randomLetters(10)}!`;
  let address = null;
  let account = null;

  for (let attempt = 1; attempt <= 10; attempt++) {
    address = `${randomLetters(10)}@${domain}`;
    try {
      account = await fetchJson(`${MAIL_TM_BASE}/accounts`, {
        method: "POST",
        body: { address, password: mailboxPassword },
      });
      break;
    } catch (e) {
      if (String(e.message).includes("422")) continue;
      throw e;
    }
  }

  if (!account?.id) throw new Error("mail.tm: Failed to create account after retries");

  const tokenResp = await fetchJson(`${MAIL_TM_BASE}/token`, {
    method: "POST",
    body: { address, password: mailboxPassword },
  });

  if (!tokenResp?.token) throw new Error("mail.tm: Token response did not include token");

  return { address, password: mailboxPassword, token: tokenResp.token, accountId: account.id, domain };
}

/**
 * Poll mail.tm until the confirmation link appears in a message body.
 */
async function waitForConfirmationLink({ token, timeoutMs = 120_000, pollEveryMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;

  // Strict match: confirmation-token/<UUID>
  const re = /https?:\/\/client\.embyiltv\.io\/confirmation-token\/[0-9a-fA-F-]{36}/;

  while (Date.now() < deadline) {
    const msgList = await fetchJson(`${MAIL_TM_BASE}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const messages = msgList?.["hydra:member"] || [];

    for (const m of messages) {
      const id = m?.id;
      if (!id) continue;

      const full = await fetchJson(`${MAIL_TM_BASE}/messages/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const text = typeof full?.text === "string" ? full.text : "";
      const html =
        typeof full?.html === "string"
          ? full.html
          : Array.isArray(full?.html)
          ? full.html.join("\n")
          : "";

      const combined = `${text}\n${html}`;
      const match = combined.match(re);
      if (match?.[0]) return match[0];
    }

    await sleep(pollEveryMs);
  }

  throw new Error(`Timed out waiting for confirmation email (${timeoutMs}ms)`);
}

async function closeAllTabs(context) {
  // Close every open page/tab in this browser context
  const pages = context.pages();
  for (const p of pages) {
    try {
      if (!p.isClosed()) await p.close();
    } catch {
      // ignore close errors
    }
  }
}

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const context = await browser.newContext();

  try {
    // Step 1) Create mail.tm inbox
    const mailbox = await createMailTmMailbox();
    const email = mailbox.address;
    console.log("MAIL_TM_EMAIL:", email);

    // Step 2) Sign up
    const pageSignup = await context.newPage();
    await pageSignup.goto("https://client.embyiltv.io/sign-up", { waitUntil: "domcontentloaded" });

    await pageSignup.locator('input[name="firstName"]').fill(randomLetters(4));
    await pageSignup.locator('input[name="lastName"]').fill(randomLetters(4));
    await pageSignup.locator('input[name="email"]').fill(email);
    await pageSignup.locator('input[name="password"]').fill("Aa123456!");
    await pageSignup.locator('input[name="confirmPassword"]').fill("Aa123456!");

    const submitBtn = pageSignup.locator('button[type="submit"]', { hasText: "הרשמה" }).first();
    await submitBtn.waitFor({ state: "visible" });

    await Promise.all([
      submitBtn.click(),
      pageSignup.waitForLoadState("networkidle").catch(() => null),
    ]);

    // Step 3) Get confirmation URL from mail.tm
    const confirmUrl = await waitForConfirmationLink({
      token: mailbox.token,
      timeoutMs: 120_000,
      pollEveryMs: 1000,
    });

    console.log("CONFIRMATION_URL:", confirmUrl);

    // ============================================================
    // LOGGING (unchanged) — and then continue with your steps
    // ============================================================

    const pageConfirm = await context.newPage();

    pageConfirm.on("console", (msg) => {
      console.log("PAGE_CONSOLE:", msg.type(), msg.text());
    });

    pageConfirm.on("pageerror", (err) => {
      console.log("PAGE_ERROR:", err.message);
    });

    pageConfirm.on("requestfailed", (req) => {
      console.log("REQ_FAILED:", req.failure()?.errorText, req.method(), req.url());
    });

    pageConfirm.on("response", async (res) => {
      const url = res.url();
      const isInteresting =
        url.includes("/confirmation-token/") ||
        url.includes("/confirmation") ||
        url.includes("/api/") ||
        url.includes("/auth") ||
        url.includes("/login") ||
        url.includes("/subscriptions");

      if (!isInteresting) return;

      const status = res.status();
      console.log("RESP:", status, url);

      try {
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (
          ct.includes("application/json") ||
          ct.includes("text/") ||
          ct.includes("application/javascript") ||
          ct.includes("application/xml") ||
          ct.includes("application/problem+json")
        ) {
          const body = await res.text();
          if (body) console.log("RESP_BODY_SNIP:", body.slice(0, 500));
        }
      } catch (e) {
        console.log("RESP_BODY_SNIP: <unable to read>", String(e?.message || e));
      }
    });

    // Step 4) Navigate to confirmation URL
    await pageConfirm.goto(confirmUrl, { waitUntil: "domcontentloaded" });

    // Step 5) Click <button> with value/text "חזרה להתחברות"
    const backToLoginBtn = pageConfirm.locator("button", { hasText: "חזרה להתחברות" }).first();
    await backToLoginBtn.waitFor({ state: "visible" });

    await Promise.all([
      pageConfirm.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => null),
      backToLoginBtn.click(),
    ]);

    // Step 6) Wait 5 seconds so the confirmation is fully processed server-side
    await pageConfirm.waitForTimeout(5000);

    // Step 7) Fill login page: <input name="login"> with the email
    const loginField = pageConfirm.locator('input[name="login"]').first();
    await loginField.waitFor({ state: "visible" });
    await loginField.fill(email);

    // Step 8) Fill login page: <input name="password"> with Aa123456!
    const loginPass = pageConfirm.locator('input[name="password"]').first();
    await loginPass.waitFor({ state: "visible" });
    await loginPass.fill("Aa123456!");

    // Step 9) Press <button type="submit"> to login
    const loginSubmit = pageConfirm.locator('button[type="submit"]').first();
    await loginSubmit.waitFor({ state: "visible" });

    await Promise.all([
      pageConfirm.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => null),
      loginSubmit.click(),
    ]);

    // Step 10) Wait for /subscriptions to load
    await pageConfirm.waitForURL("**/subscriptions**", { timeout: 15000 }).catch(() => null);

    // Step 11) Build desired username: romani + ddmmyy
    const desiredLogin = `romani${ddmmyyToday()}`;

    // Step 12) Wait 5 seconds before filling the subscription form (inputs may mount late)
    await pageConfirm.waitForTimeout(5000);

    // Step 13) Fill <input name="login"> with desiredLogin
    const newLoginInput = pageConfirm.locator('input[name="login"]').first();
    await newLoginInput.waitFor({ state: "visible" });
    await newLoginInput.fill("romani021225");

    // Step 14) Fill <input name="password"> with Aa123456!
    const newPassInput = pageConfirm.locator('input[name="password"]').first();
    await newPassInput.waitFor({ state: "visible" });
    await newPassInput.fill("Aa123456!");

    // Step 15) Fill <input name="confirmPassword"> with Aa123456!
    const newConfirmInput = pageConfirm.locator('input[name="confirmPassword"]').first();
    await newConfirmInput.waitFor({ state: "visible" });
    await newConfirmInput.fill("Aa123456!");

    // Step 16) Click <button> with value/text "אשר"
    const approveBtn = pageConfirm.locator("button", { hasText: "אשר" }).first();
    await approveBtn.waitFor({ state: "visible" });

    await Promise.all([
      approveBtn.click(),
      pageConfirm.waitForLoadState("networkidle").catch(() => null),
    ]);

    // Step 17) Print email + user used
    console.log(`email is: ${email}`);
    console.log(`user is: ${desiredLogin}`);

    // Step 18) Print a line with ONLY the desiredLogin
    console.log(desiredLogin);

    // Step 19) Close all tabs and finish automation
    await closeAllTabs(context);
  } finally {
    // Ensure browser is closed even if something throws
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
