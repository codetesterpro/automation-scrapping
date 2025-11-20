import { chromium } from "playwright";
import fs from "fs";
import { dayjs, getDateRangeFromEnv, ZONE } from "./utils/date.js";
import { uploadToGoogleSheet } from "./services/googleSheet.js";
import "dotenv/config";

const email = process.env.EMAIL;
const password = process.env.PASSWORD;
const BATCH_SIZE = 10;
const MAX_RETRY = 1;

const projects = JSON.parse(fs.readFileSync("projects.json", "utf-8"));
const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf-8"));
// ambil dari env (GitHub Secrets / .env lokal)
const spreadsheetId = process.env.SPREADSHEET_ID;
const LUNA_BASE_URL = process.env.LUNA_BASE_URL || "https://partner.lunahubs.com";

const { startDate, endDate } = getDateRangeFromEnv();

console.log(
  `[DATE RANGE] ${startDate.format("YYYY-MM-DD")} → ${endDate.format(
    "YYYY-MM-DD"
  )} (${ZONE})`
);


async function login(page) {
  await page.goto(`${LUNA_BASE_URL}/login`);
  await page.fill("#data\\.email", email);
  await page.fill("#data\\.password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${LUNA_BASE_URL}/`, { timeout: 15000 });
  await page.goto(`${LUNA_BASE_URL}/transaction-reports`);
  await page.waitForSelector("text=Transaction Reports", { timeout: 10000 });
}

async function scrapeProject(page, dateLabel, dateStr, project, retry = 0) {
  const encodedDate = encodeURIComponent(dateStr);
  const url = `${LUNA_BASE_URL}/transaction-reports?filters[date]=${encodedDate}&filters[projects][0]=${project.id}`;

  try {
    await page.goto(url, { waitUntil: "networkidle" });

    if (page.url().includes("/login")) {
      if (retry >= MAX_RETRY) throw new Error("Session expired");
      await login(page); // Login ulang jika sesi kedaluwarsa
      await page.waitForTimeout(4000);
      return await scrapeProject(page, dateLabel, dateStr, project, retry + 1); // Coba lagi
    }
    // Menunggu elemen untuk muncul dan menangani error jika tidak ditemukan
    try {
      await page.waitForSelector("span.fi-wi-stats-overview-stat-description", {
        timeout: 10000,
      });
    } catch (err) {
      console.error(
        `❌ ${project.name} @ ${dateLabel}: Selector not found`,
        err
      ); // Log jika selector tidak ditemukan
      return "ERROR"; // Mengembalikan error jika elemen tidak ditemukan
    }

    // Menunggu elemen dan mengambil nilai transaksi
    const amountText = await page.textContent(
      "span.fi-wi-stats-overview-stat-description"
    );

    
    const cleanedAmount = amountText
      .replace(/[^\d.,-]/g, "")   // sisakan digit, koma, titik, minus
      .replace(/\./g, "")         // hapus pemisah ribuan (titik)
      .replace(/,/g, ".")         // ubah koma menjadi titik desimal
      .trim();
    const amount = parseFloat(cleanedAmount); // Mengubah menjadi angka

    console.log(
      `✅ ${project.name} @ ${dateLabel}: Rp${amount.toLocaleString()}`
    );
    return amount; // Format dengan pemisah ribuan
  } catch (err) {
    console.error(`❌ ${project.name} @ ${dateLabel}: ERROR`, err); // Log error lebih lengkap
    return "ERROR";
  }
}

async function scrapeProjectWithRetry(page, dateLabel, dateStr, project) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const result = await scrapeProject(page, dateLabel, dateStr, project, attempt);
    if (result !== "ERROR") return result;
    console.warn(`🔁 Retry ke-${attempt + 1} untuk ${project.name}`);
  }
  return "ERROR";
}



(async () => {
  const failedSummary = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const mainPage = await context.newPage();

  await login(mainPage);

  const pages = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const p = await context.newPage();
    await p.goto(`${LUNA_BASE_URL}/transaction-reports`);
    pages.push(p);
  }

  let currentDate = startDate;

  while (currentDate.isSameOrBefore(endDate, "day")) {
    const sheetName = currentDate.format("MMMM YYYY");
    const dateLabel = currentDate.format("D");
    const dateStr = `${currentDate.format("YYYY-MM-DD")} - ${currentDate.format(
      "YYYY-MM-DD"
    )}`;
    const amounts = [];

    console.log(`📅 Memproses data untuk ${dateLabel}`);

    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      const batch = projects.slice(i, i + BATCH_SIZE);
      const tasks = batch.map((project, idx) =>
        scrapeProjectWithRetry(
          pages[idx % BATCH_SIZE],
          dateLabel,
          dateStr,
          project
        )
      );

      const results = await Promise.all(tasks);
      amounts.push(...results);
    }

    const successCount = amounts.filter((x) => x !== "ERROR").length;
    const failCount = amounts.length - successCount;

    console.log(
      `📊 Scraping selesai: ${successCount}/${projects.length} projects berhasil.`
    );
    console.log(`📈 Total Berhasil: ${successCount}, Gagal: ${failCount}`);

    // 🔎 Kalau ada yang gagal, catat ID + nama project ke failedSummary (tapi TETAP upload)
    if (failCount > 0) {
      const failedItems = projects
        .map((p, idx) => ({ id: p.id, name: p.name, value: amounts[idx] }))
        .filter((x) => x.value === "ERROR");

      const failedDisplay = failedItems
        .map((x) => `${x.id} - ${x.name}`)
        .join(", ");

      console.error(
        `⚠️ Ada ${failedItems.length} project gagal untuk tanggal ${dateLabel} (${currentDate.format(
          "YYYY-MM-DD"
        )}).`
      );
      console.error(`   List gagal: ${failedDisplay}`);

      // Simpan ringkasan untuk log di akhir
      failedSummary.push({
        date: currentDate.format("YYYY-MM-DD"),
        label: dateLabel,
        failedProjects: failedItems.map(({ id, name }) => ({ id, name })),
      });
    }

    // Tetap SELALU upload ke Google Sheet (perilaku awal)
    await uploadToGoogleSheet(
      projects,
      amounts,
      sheetName,
      dateLabel,
      credentials,
      spreadsheetId
    );

    currentDate = currentDate.add(1, "day");
  }

  await browser.close();

  // 🧾 Ringkasan akhir setelah semua tanggal diproses
  if (failedSummary.length > 0) {
    console.error("⚠️ RINGKASAN PROJECT GAGAL SELAMA PERIODE INI:");
    failedSummary.forEach((item) => {
      const listDisplay = item.failedProjects
        .map((p) => `${p.id} - ${p.name}`)
        .join(", ");

      console.error(
        `  - Tanggal ${item.date} (label ${item.label}): ${listDisplay}`
      );
    });

    // (Optional untuk masa depan: simpan ke file agar bisa di-retry otomatis)
    // fs.writeFileSync(
    //   "failed-jobs.json",
    //   JSON.stringify(failedSummary, null, 2),
    //   "utf-8"
    // );
    // console.error('📁 Detail gagal disimpan ke failed-jobs.json');
  } else {
    console.log("✅ Semua project berhasil di-scrape untuk seluruh tanggal.");
  }
})();
