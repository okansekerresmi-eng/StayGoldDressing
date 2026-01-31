const puppeteer = require("puppeteer-core");
const { google } = require("googleapis");
const speakeasy = require("speakeasy");
const fs = require("fs");
const path = require("path");
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
const { exec } = require("child_process");

function runChromeDebugBat() {
  return new Promise((resolve) => {
    exec(
      `"${path.join(__dirname, "chrome-debug.bat")}"`,
      (err) => {
        if (err) {
          console.error("⚠️ chrome-debug.bat çalıştırılamadı:", err.message);
        } else {
          console.log("🚀 chrome-debug.bat çalıştırıldı.");
        }
        resolve(); // HATA OLSA BİLE DEVAM
      }
    );
  });
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
function runProfileUploader() {
  return new Promise((resolve) => {
    console.log("🚀 profile.js çalıştırılıyor...");

    exec(
      `node "${path.join(__dirname, "profile.js")}"`,
      (err, stdout, stderr) => {
        if (err) {
          console.error("❌ profile.js hata verdi:", err.message);
        }
        if (stdout) console.log("[profile.js stdout]", stdout);
        if (stderr) console.error("[profile.js stderr]", stderr);
        resolve();
      }
    );
  });
}
function getRandomCredentialFile() {
  const files = fs.readdirSync(CREDENTIALS_DIR).filter(f => f.endsWith(".json"));
  if (!files.length) throw new Error("credentials klasörü boş");
  return path.join(CREDENTIALS_DIR, files[Math.floor(Math.random() * files.length)]);
}

async function clickConfirmButton(page, timeout = 45000) {
  const rx = "^(confirm|onayla|continue|devam)$";

  // 1) Direct <button> text match
  const btnHandle = await page.waitForFunction(
    (pattern) => {
      const r = new RegExp(pattern, "i");
      const btn = [...document.querySelectorAll("button")]
        .find(b => b.offsetParent !== null && r.test((b.innerText || "").trim()));
      return btn || false;
    },
    { timeout },
    rx
  ).catch(() => null);

  if (btnHandle) {
    await page.evaluate((pattern) => {
      const r = new RegExp(pattern, "i");
      const btn = [...document.querySelectorAll("button")]
        .find(b => b.offsetParent !== null && r.test((b.innerText || "").trim()));
      if (btn) {
        btn.scrollIntoView({ block: "center" });
        btn.click();
      }
    }, rx);

    await page.keyboard.press("Enter");
    return;
  }

  // 2) Fallback: find span and click its clickable parent
  await page.waitForFunction(
    (pattern) => {
      const r = new RegExp(pattern, "i");
      return [...document.querySelectorAll("span, div, button, [role='button']")]
        .some(n =>
          n.offsetParent !== null &&
          r.test(((n.innerText || "")).trim())
        );
    },
    { timeout },
    rx
  );

  await page.evaluate((pattern) => {
    const r = new RegExp(pattern, "i");

    // Prefer button/role=button matches first
    let el =
      [...document.querySelectorAll("button,[role='button']")]
        .find(n => n.offsetParent !== null && r.test((n.innerText || "").trim())) ||
      null;

    // If still not found, try span then climb up
    if (!el) {
      const span = [...document.querySelectorAll("span")]
        .find(s => s.offsetParent !== null && r.test((s.innerText || "").trim()));
      if (!span) throw new Error("Confirm yazısı bulunamadı");

      el = span;
      while (el && el !== document.body) {
        if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") break;
        el = el.parentElement;
      }
    }

    if (!el) throw new Error("Confirm için tıklanabilir eleman bulunamadı");

    el.scrollIntoView({ block: "center" });
    el.click();
  }, rx);

  // 3) Extra guarantee
  await page.keyboard.press("Enter");
}
async function markBioDone(sheets, row) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!E${row}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["BIO"]],
    },
  });

  console.log(`🧾 E${row} → BIO`);
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
async function getLoggedInUsernameIfExists(page) {
  return await page.evaluate(() => {
    const img = [...document.querySelectorAll("img")]
      .find(i =>
        i.alt &&
        i.alt.endsWith("'s profile picture")
      );

    if (!img) return null;

    // "kgizem.bozdagkalaycioglu290's profile picture"
    return img.alt.replace("'s profile picture", "").trim();
  });
}
async function markUserOnline(sheets, username) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:A`,
  });

  const rows = res.data.values || [];

  const index = rows.findIndex(r => {
    if (!r[0]) return false;
    const sheetUsername = r[0].split("-")[0].trim();
    return sheetUsername === username;
  });

  if (index === -1) {
    console.log("⚠️ Sheet’te kullanıcı bulunamadı:", username);
    return;
  }

  const rowNumber = index + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!C${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["online"]],
    },
  });

  console.log(`🟢 ${username} → C${rowNumber} = online`);
}

async function forceClickNotNow(page, timeout = 20000) {
  try {
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('[role="button"]')]
        .some(el =>
          el.offsetParent &&
          el.textContent &&
          el.textContent.trim().toLowerCase() === "not now"
        );
    }, { timeout });

    await page.evaluate(() => {
      const el = [...document.querySelectorAll('[role="button"]')]
        .find(e =>
          e.offsetParent &&
          e.textContent &&
          e.textContent.trim().toLowerCase() === "not now"
        );

      if (!el) throw new Error("Not now bulunamadı");

      el.scrollIntoView({ block: "center" });

      // gerçek kullanıcı click simülasyonu
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    console.log("🚫 NOT NOW (role=button) tıklandı");
    await page.waitForTimeout(1500);
  } catch {
    console.log("ℹ️ Not now popup yok / atlandı");
  }
}
function runBioUploader() {
  return new Promise((resolve) => {
    console.log("🧬 bio.js çalıştırılıyor...");

    exec(
      `node "${path.join(__dirname, "bio.js")}"`,
      (err, stdout, stderr) => {
        if (err) {
          console.error("❌ bio.js hata verdi:", err.message);
        }
        if (stdout) console.log("[bio.js stdout]", stdout);
        if (stderr) console.error("[bio.js stderr]", stderr);
        resolve();
      }
    );
  });
}

function startHumanConfirmWatcher(page, sheets, username, row) {
  let stopped = false;

  const interval = setInterval(async () => {
    if (stopped) return;

    try {
      const flagged = await page.evaluate((u) => {
        const spans = [...document.querySelectorAll("span[role='heading']")];
        return spans.some(s =>
          s.innerText &&
          s.innerText.toLowerCase().includes("confirm you're human") &&
          s.innerText.includes(u)
        );
      }, username);

      if (flagged) {
        stopped = true;
        clearInterval(interval);

        console.log("🚩 HUMAN CONFIRM TESPİT EDİLDİ → FLAGGED");

        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_NAME}!C${row}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [["Flagged"]],
          },
        });

        console.log(`🚩 C${row} → Flagged`);
      }
    } catch (e) {
      // sessiz geç — navigation sırasında hata olabilir
    }
  }, 1500); // ⏱️ 1.5 saniyede bir kontrol
}

async function clickLoginButton(page, timeout = 45000) {
  await page.waitForFunction(
    () => {
      return [...document.querySelectorAll("span")]
        .some(s =>
          s.innerText &&
          /^(log in|giriş yap)$/i.test(s.innerText.trim()) &&
          s.offsetParent !== null
        );
    },
    { timeout }
  );

  await page.evaluate(() => {
    const span = [...document.querySelectorAll("span")]
      .find(s =>
        s.innerText &&
        /^(log in|giriş yap)$/i.test(s.innerText.trim()) &&
        s.offsetParent !== null
      );

    if (!span) throw new Error("Login span bulunamadı");

    let el = span;
    while (el && el !== document.body) {
      if (
        el.tagName === "BUTTON" ||
        el.getAttribute("role") === "button"
      ) break;
      el = el.parentElement;
    }

    if (!el) throw new Error("Login için tıklanabilir parent yok");

    el.scrollIntoView({ block: "center" });
    el.click();
  });

  // ekstra garanti
  await page.keyboard.press("Enter");
}
async function hasProfilePhoto(page) {
  return await page.evaluate(() => {
    const img = [...document.querySelectorAll("img")]
      .find(i =>
        i.alt &&
        i.alt.endsWith("'s profile picture")
      );

    if (!img || !img.src) return false;

    const src = img.src.toLowerCase();

    // default / boş avatarlar
    if (
      src.includes("anonymous") ||
      src.includes("silhouette") ||
      src.includes("default")
    ) {
      return false;
    }

    // gerçek instagram profil foto
    if (src.includes("fbcdn.net") && src.includes(".jpg")) {
      return true;
    }

    return false;
  });
}
async function getBioStatusFromSheet(sheets, row) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!E${row}`,
  });

  const val = res.data.values?.[0]?.[0] || "";
  return val.trim().toUpperCase(); // "BIO" ya da ""
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
    // 1️⃣ Chrome Debug BAT
    await runChromeDebugBat();

    // 2️⃣ Debug port hazır olana kadar bekle
    await waitForDebugPort();

    // 3️⃣ Google Sheets auth
    const auth = new google.auth.GoogleAuth({
      keyFile: getRandomCredentialFile(),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // 4️⃣ Açık Chrome’a bağlan
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
      defaultViewport: null,
    });

    const page = (await browser.pages())[0] || (await browser.newPage());

    // 5️⃣ Instagram ana sayfasına git
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
    });

    // 6️⃣ ZATEN LOGIN VAR MI?
    const loggedUser = await getLoggedInUsernameIfExists(page);

    if (loggedUser) {
      console.log("✅ Zaten giriş yapılmış:", loggedUser);

      // Sheet → online
      await markUserOnline(sheets, loggedUser);

      // Profil foto kontrol
      const hasPP = await hasProfilePhoto(page);

      if (hasPP) {
        console.log("🖼️ Profil foto VAR");

        // D sütunu → PP var
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_NAME}!A:A`,
        });

        const rows = res.data.values || [];
        const rowIndex = rows.findIndex(r =>
          r[0] && r[0].split("-")[0].trim() === loggedUser
        );

        if (rowIndex !== -1) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!D${rowIndex + 1}`,
            valueInputOption: "RAW",
            requestBody: {
              values: [["PP var"]],
            },
          });

          console.log(`📝 D${rowIndex + 1} → PP var`);
        }
      } else {
        console.log("⚠️ Profil foto YOK → profile.js çalıştırılıyor");
        await runProfileUploader();
      }

      console.log("⛔ Login atlandı, script bitti.");
      return;
    }

    /* ================= LOGIN FLOW ================= */

    // 7️⃣ Sheet’ten rastgele hesap al
    const { username, password, rawSecret, row } =
      await getRandomInstagramAccount();

    startHumanConfirmWatcher(page, sheets, username, row);
    console.log("📸 Login yapılacak IG:", username);

    await page.goto(INSTAGRAM_LOGIN_URL, {
      waitUntil: "domcontentloaded",
    });

    // USERNAME
    await typeFirstAvailable(
      page,
      [
        'input[name="username"]',
        'input[name="email"]',
        'input[autocomplete="username"]',
      ],
      username
    );

    // PASSWORD
    await typeFirstAvailable(
      page,
      [
        'input[name="password"]',
        'input[name="pass"]',
        'input[autocomplete="current-password"]',
      ],
      password
    );

    await clickLoginButton(page);
    console.log("🔐 Login gönderildi");

    /* ================= 2FA ================= */
    await page.waitForSelector('input[name="verificationCode"]', {
      timeout: 60000,
    });

    const code = generate2FA(rawSecret);
    console.log("🔐 2FA Kod:", code);

    await typeFirstAvailable(
      page,
      ['input[name="verificationCode"]', 'input[type="tel"]'],
      code
    );

    await clickConfirmButton(page);
    await page.waitForTimeout(1000);
    await forceClickNotNow(page);
    await forceClickNotNow(page); // Instagram bazen 2 popup atıyor
    
    /* ================= PROFIL CHECK ================= */
    await page.waitForFunction(
      (u) =>
        location.pathname === "/" ||
        location.pathname.includes(`/${u}`),
      { timeout: 60000 },
      username
    );

    console.log("✅ Profil açıldı");

    // LOGIN SONRASI PROFİL FOTO KONTROL

    const hasPPAfterLogin = await hasProfilePhoto(page);

    if (hasPPAfterLogin) {
      console.log("🖼️ Profil foto VAR (login sonrası)");
    } else {
      console.log("⚠️ Profil foto YOK → profile.js çalıştırılıyor");
      await runProfileUploader(); // ⛔ önce PP
    }

    // 🔍 BIO durumu kontrol (E sütunu)
    const bioStatus = await getBioStatusFromSheet(sheets, row);

    if (bioStatus !== "BIO") {
      console.log("🧬 BIO yok → bio.js çalıştırılacak");

      // profile.js çalıştıysa onun bitmesini bekledik zaten
      await runBioUploader();

      // BIO işaretle
      await markBioDone(sheets, row);
    } else {
      console.log("ℹ️ BIO zaten var → bio.js atlandı");
    }


    // B sütunu → +
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
