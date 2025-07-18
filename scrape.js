import { chromium } from "playwright";
import fs from "fs";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore.js";
import { google } from "googleapis";
import "dotenv/config";

dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);

// 🟢 DEBUG: Cek waktu lokal & Jakarta
// console.log("Default Dayjs:", dayjs().format());
// console.log("Jakarta Time:", dayjs().tz('Asia/Jakarta').format());

const email = process.env.EMAIL;
const password = process.env.PASSWORD;
const BATCH_SIZE = 10;
const MAX_RETRY = 1;

const projects = JSON.parse(fs.readFileSync("projects.json", "utf-8"));
const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf-8"));
const spreadsheetId = "1qd7VoQ79ZJ3aOrXT7omHmjatqWgoINSXsWoYe0IPBTc";

const startDate = dayjs().tz('Asia/Jakarta').subtract(1, 'day');
const endDate = startDate;

// const startDate = dayjs("2025-07-16");
// const endDate = dayjs("2025-07-16");

const sheetName = startDate.format("MMMM YYYY"); // Contoh: "July 2025"
// const dateHeader = startDate.format("MMMM D"); // Contoh: "July 9"

async function login(page) {
  await page.goto("https://partner.lunahubs.com/login");
  await page.fill("#data\\.email", email);
  await page.fill("#data\\.password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("https://partner.lunahubs.com/", { timeout: 15000 });
  await page.goto("https://partner.lunahubs.com/transaction-reports");
  await page.waitForSelector("text=Transaction Reports", { timeout: 10000 });
}

async function scrapeProject(page, dateLabel, dateStr, project, retry = 0) {
  const encodedDate = encodeURIComponent(dateStr);
  const url = `https://partner.lunahubs.com/transaction-reports?filters[date]=${encodedDate}&filters[projects][0]=${project.id}`;

  try {
    await page.goto(url, { waitUntil: "networkidle" });

    if (page.url().includes("/login")) {
      if (retry >= MAX_RETRY) throw new Error("Session expired");
      await login(page); // Login ulang jika sesi kedaluwarsa
      // Memberikan penundaan sebelum mencoba kembali
      await page.waitForTimeout(4000); // Tunggu 3 detik
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

    // Memperbaiki pemformatan angka (menghapus "Rp", titik, dan koma)
    const cleanedAmount = amountText
      .replace(/[^\d,-]/g, "")
      .replace(",", "")
      .replace(".", "")
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

async function ensureSheetExists(spreadsheetId, sheetName, sheets) {
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetExists = response.data.sheets.some(
    (s) => s.properties.title === sheetName
  );

  let sheetId; // Deklarasikan sheetId
  if (!sheetExists) {
    console.log(`📄 Sheet "${sheetName}" belum ada. Membuat baru...`);
    const updateResponse = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
              },
            },
          },
        ],
      },
    });
    // Ambil sheetId dari respons setelah sheet baru dibuat
    const newSheet = updateResponse.data.replies[0].addSheet;
    sheetId = newSheet.properties.sheetId;

    console.log(`✅ Sheet "${sheetName}" berhasil dibuat`);
  } else {
    // Jika sheet sudah ada, ambil sheetId
    const existingSheet = response.data.sheets.find(
      (s) => s.properties.title === sheetName
    );
    sheetId = existingSheet.properties.sheetId;
  }

  return sheetId; // Kembalikan sheetId yang digunakan untuk update dan format
}

async function uploadToGoogleSheet(projects, values, sheetName, columnDate) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  // Dapatkan sheetId dari ensureSheetExists
  const sheetId = await ensureSheetExists(spreadsheetId, sheetName, sheets);

  // Ambil data yang sudah ada di sheet
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z1000`,
  });

  console.log("Sheet ID:", sheetId); // Debugging: cek ID sheet yang ditemukan

  let data = res.data.values || [];
  const header = data[0] || ["Name"];
  let colIndex = header.indexOf(columnDate);

  // Tambah header jika belum ada
  if (colIndex === -1) {
    header.push(columnDate);
    colIndex = header.length - 1;
  }
  data[0] = header;

  let totalRowIndex = data.findIndex((row) => row[0] === "Total") + 1;
  
  // Update atau tambah baris
  for (let i = 0; i < projects.length; i++) {
    const name = projects[i].name;
    const idx = data.findIndex((row) => row[0] === name);
  if (idx === -1) {
    const newRow = Array(colIndex + 1).fill("");
    newRow[0] = name;
    newRow[colIndex] = values[i];

  if (totalRowIndex > 0) {
    data.splice(totalRowIndex - 1, 0, newRow); // Insert sebelum Total
    totalRowIndex++; // Geser Total ke bawah
    } else {
      data.push(newRow);
      }
    } else {
    // 🟩 Update nilai jika project sudah ada
    if (data[idx].length <= colIndex) {
      data[idx] = [...data[idx], ...Array(colIndex + 1 - data[idx].length).fill("")];
    }
    data[idx][colIndex] = values[i];
    }
  }
  // Update data di Google Sheets
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: data },
  });

  const startRow = 2;
  // Tentukan baris SUM: baris setelah data terakhir
  let endRow = data.length;
  totalRowIndex = data.findIndex((row) => row[0] === "Total") + 1;
  // Jika Total belum ada, buat di baris terakhir
  if (totalRowIndex === 0) {
    totalRowIndex = data.length + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${totalRowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [["Total"]] },
    });
  } else {
    // Jika sudah ada, endRow jangan termasuk baris Total
    endRow = totalRowIndex - 1;
  }

  totalRowIndex = data.findIndex(row => row[0] === 'Total') + 1;

  if (endRow - startRow <= 0) {
    console.log("⚠️ Tidak ada data untuk diformat sebagai currency.");
    return;
  }

  console.log(`✅ Data berhasil diupdate di Google Sheets [${sheetName}]`);
  // Mengatur format currency untuk kolom tersebut
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId,
              startRowIndex: startRow - 1,
              endRowIndex: endRow,
              startColumnIndex: colIndex,
              endColumnIndex: colIndex + 1,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: {
                  type: "CURRENCY",
                  pattern: '"Rp"#,##0',
                },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    },
  });

  console.log(
    `✅ Data berhasil diupdate & diformat sebagai IDR di Google Sheets [${sheetName}]`
  );

  const colLetter = String.fromCharCode(65 + colIndex);
  const sumRow = endRow + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${colLetter}${sumRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[`=SUM(${colLetter}${startRow}:${colLetter}${endRow})`]],
    },
  });

  console.log(`✅ Formula SUM ditulis di baris ${sumRow} kolom ${colLetter}`
  );
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const mainPage = await context.newPage();

  await login(mainPage);

  const pages = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const p = await context.newPage();
    await p.goto("https://partner.lunahubs.com/transaction-reports");
    pages.push(p);
  }

  let currentDate = startDate;

  while (currentDate.isSameOrBefore(endDate, "day")) {
    const dateLabel = currentDate.format("MMMM D");
    const dateStr = `${currentDate.format("YYYY-MM-DD")} - ${currentDate.format(
      "YYYY-MM-DD"
    )}`;
    const amounts = [];

    console.log(`📅 Memproses data untuk ${dateLabel}`);

    for (let i = 0; i < projects.length; i += BATCH_SIZE) {
      const batch = projects.slice(i, i + BATCH_SIZE);
      const tasks = batch.map((project, idx) =>
        scrapeProject(pages[idx % BATCH_SIZE], dateLabel, dateStr, project)
      );

      const results = await Promise.all(tasks);
      amounts.push(...results);
    }

    const successCount = amounts.filter((x) => x !== "ERROR").length;
    console.log(
      `📊 Scraping selesai: ${successCount}/${projects.length} projects berhasil.`
    );
    await uploadToGoogleSheet(projects, amounts, sheetName, dateLabel);

    currentDate = currentDate.add(1, "day");
  }
  await browser.close();
})();
