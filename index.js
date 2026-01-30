const puppeteer = require("puppeteer-core");
const { google } = require("googleapis");
const speakeasy = require("speakeasy");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

/* ================= CONFIG ================= */
const CHROME_PATH =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const INSTAGRAM_LOGIN_URL = "https://www.instagram.com/accounts/login/";
const DEBUG_PORT = 9222;

const SHEET_ID = "103PO8X7OcXdh76ZqdmdpDhNbuI6yhRo6IxRhnNFgBCw";
const SHEET_NAME = "Insta";
const CREDENTIALS_DIR = path.join(__dirname, "credentials");
/* ========================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getUniqueProfileDir() {
  return path.join(
    __dirname,
    "tmp_chrome_profile_" + Date.now() + "_" + Math.floor(Math.random() * 9000 + 1000)
  );
}

function launchChromeDebug() {
  const profileDir = getUniqueProfileDir();
  return spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--start-maximized",
    ],
    { detached: true, stdio: "ignore" }
  );
}

function waitForDebugPort(timeout = 20000) {
  const start = Date.now();
  const url = `http://127.0.0.1:${DEBUG_PORT}/json/version`;

  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeout)
        return reject(new Error("Chrome debug port açılmadı"));

      http.get(url, (res) => {
        if (res.statusCode !== 200) return setTimeout(check, 500);
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.webSocketDebuggerUrl) return resolve();
          } catch {}
          setTimeout(check, 500);
        });
      }).on("error", () => setTimeout(check, 500));
    };
    check();
  });
}

function getRandomCredentialFile() {
  const files = fs.readdirSync(CREDENTIALS_DIR).filter(f => f.endsWith(".json"));
  if (!files.length) throw new Error("credentials klasörü boş");
  return path.join(CREDENTIALS_DIR, files[Math.floor(Math.random() * files.length)]);
}

async function getRandomInstagramAccount() {
  const auth = new google.auth.GoogleAuth({
    keyFile: getRandomCredentialFile(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:A`,
  });

  const indexed = (res.data.values || [])
    .map((r, i) => ({ value: r[0], row: i + 1 }))
    .filter(o => o.value && o.value.split("-").length >= 3);

  if (!indexed.length) throw new Error("Sheet A sütunu boş");

  const pick = indexed[Math.floor(Math.random() * indexed.length)];
  const [username, password, rawSecret] = pick.value.split("-");

  return { username, password, rawSecret, row: pick.row, sheets };
}

function generate2FA(secretRaw) {
  const secret = secretRaw.replace(/\s+/g, "").toUpperCase();
  return speakeasy.totp({
    secret,
    encoding: "base32",
  });
}
async function typeFirstAvailable(page, selectors, text) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 4000 });

      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        el.focus();
        el.value = "";
        el.setAttribute("autocomplete", "off");
        el.setAttribute("autocorrect", "off");
        el.setAttribute("autocapitalize", "off");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, selector);

      await page.type(selector, text, { delay: 80 });
      return;
    } catch {}
  }
  throw new Error("Hiçbir input bulunamadı");
}

async function typeAndClear(page, selector, text) {
  await page.waitForSelector(selector, { visible: true });
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector);
  await page.type(selector, text, { delay: 80 });
}

async function clickByText(page, textRegex) {
  await page.waitForFunction(
    rx => {
      const r = new RegExp(rx, "i");
      return [...document.querySelectorAll("button, div, span, [role='button']")]
        .some(n => n.offsetParent && r.test(n.innerText || ""));
    },
    {},
    textRegex
  );

  await page.evaluate(rx => {
    const r = new RegExp(rx, "i");
    const el = [...document.querySelectorAll("button, div, span, [role='button']")]
      .find(n => n.offsetParent && r.test(n.innerText || ""));
    el.scrollIntoView({ block: "center" });
    el.click();
  }, textRegex);
}

/* ================= MAIN ================= */
(async () => {
  try {
    const { username, password, rawSecret, row, sheets } =
      await getRandomInstagramAccount();

    console.log("📸 IG:", username);

    // Chrome başlat
    launchChromeDebug();
    await waitForDebugPort();

    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
      defaultViewport: null,
    });

    const page = (await browser.pages())[0] || (await browser.newPage());

    /* ================= LOGIN ================= */
    await page.goto(INSTAGRAM_LOGIN_URL, {
      waitUntil: "domcontentloaded",
    });

    // USERNAME
    await typeFirstAvailable(
      page,
      [
        'input[name="username"]',
        'input[name="email"]',
        'input[autocomplete="username"]'
      ],
      username
    );

    // PASSWORD
    await typeFirstAvailable(
      page,
      [
        'input[name="password"]',
        'input[name="pass"]',
        'input[autocomplete="current-password"]'
      ],
      password
    );

    await clickByText(page, "(Giriş Yap|Log\\s?in|Log\\s?In)");
    console.log("🔐 Login gönderildi");

    /* ================= 2FA ================= */
    await page.waitForSelector(
      'input[name="verificationCode"]',
      { timeout: 60000 }
    );

    const code = generate2FA(rawSecret);
    console.log("🔐 2FA Kod:", code);

    await typeFirstAvailable(
      page,
      [
        'input[name="verificationCode"]',
        'input[type="tel"]'
      ],
      code
    );

    await clickByText(page, "(Next|İleri|Continue)");

    /* ================= PROFIL CHECK ================= */
    await page.waitForFunction(
      (u) =>
        location.pathname === "/" ||
        location.pathname.includes(`/${u}`),
      { timeout: 60000 },
      username
    );

    console.log("✅ Profil açıldı");

    /* ================= SHEET UPDATE ================= */
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!B${row}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["+"]],
      },
    });

    console.log(`➕ Sheet işaretlendi → B${row}`);

  } catch (err) {
    console.error("❌ HATA:", err.message || err);
  }
})();
