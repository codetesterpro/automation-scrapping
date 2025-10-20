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

const ZONE = 'Asia/Jakarta';

// Default: H-4 s/d H-1 (WIB), bisa di-override via env (format YYYY-MM-DD)
const startDateStr = process.env.START_DATE || dayjs().tz(ZONE).subtract(4, 'day').format('YYYY-MM-DD');
const endDateStr   = process.env.END_DATE   || dayjs().tz(ZONE).subtract(1, 'day').format('YYYY-MM-DD');

const startDate = dayjs.tz(startDateStr, ZONE).startOf('day');
const endDate   = dayjs.tz(endDateStr, ZONE).endOf('day');

console.log(`[DATE RANGE] ${startDate.format('YYYY-MM-DD')} → ${endDate.format('YYYY-MM-DD')} (${ZONE})`);


// const startDate = dayjs("2025-10-01");
// const endDate = dayjs("2025-10-09");


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
                  gridProperties: {
                  rowCount: 2000,    // bebas, longgar
                  columnCount: 200,  // penting: lebih dari cukup untuk 31 hari
                },
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

async function scrapeProjectWithRetry(page, dateLabel, dateStr, project) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const result = await scrapeProject(page, dateLabel, dateStr, project, attempt);
    if (result !== "ERROR") return result;
    console.warn(`🔁 Retry ke-${attempt + 1} untuk ${project.name}`);
  }
  return "ERROR";
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

  // Helper kolom
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:ZZ1000`, // Perbesar range hingga ZZ agar tidak mentok di Z
  });

  let data = res.data.values || [];
  const header = data[0] || ["Name"];
  let colIndex = header.indexOf(columnDate);

  // Tambahkan header jika belum ada
  if (colIndex === -1) {
  header.push(columnDate);
  colIndex = header.length - 1;

  // ✅ Pastikan grid cukup kolom untuk header baru
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,gridProperties(columnCount,rowCount)))",
  });
  const sheetMeta = meta.data.sheets.find(s => s.properties.sheetId === sheetId);
  const currentCols = sheetMeta?.properties?.gridProperties?.columnCount ?? 26;

  if (currentCols < header.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: {
                  columnCount: header.length, // minimal sesuai jumlah header
                },
              },
              fields: "gridProperties.columnCount",
            },
          },
        ],
      },
    });
  }
}
data[0] = header;

  // ⬆️ Tambahkan padding ke setiap baris agar jumlah kolom sama dengan header
  for (let i = 1; i < data.length; i++) {
    if (data[i].length < header.length) {
      data[i] = [...data[i], ...Array(header.length - data[i].length).fill("")];
    }
  }

  // Hitung posisi baris Total (jika ada)
  let totalRowIndex = data.findIndex((row) => row[0] === "Total") + 1;

  // Update atau tambahkan project
  for (let i = 0; i < projects.length; i++) {
    const name = projects[i].name;
    const idx = data.findIndex((row) => row[0] === name);

    if (idx === -1) {
      const newRow = Array(header.length).fill("");
      newRow[0] = name;
      newRow[colIndex] = values[i];

      if (totalRowIndex > 0) {
        data.splice(totalRowIndex - 1, 0, newRow); // Insert sebelum Total
        totalRowIndex++;
      } else {
        data.push(newRow);
      }
    } else {
      if (data[idx].length <= colIndex) {
        data[idx] = [...data[idx], ...Array(colIndex + 1 - data[idx].length).fill("")];
      }
      data[idx][colIndex] = values[i];
    }
  }

  // Update header ulang (jaga-jaga)
  data[0] = header;

  // Upload ke Google Sheet
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: data },
  });

  console.log(`✅ Data berhasil diupdate di Google Sheets [${sheetName}]`);

  const startRow = 2;
  let endRow = data.length;
  totalRowIndex = data.findIndex((row) => row[0] === "Total") + 1;

  // Tambahkan baris Total jika belum ada
  if (totalRowIndex === 0) {
    totalRowIndex = data.length + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${totalRowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [["Total"]] },
    });
    console.log(`ℹ️  Baris "Total" dibuat di baris ${totalRowIndex}`);
  } else {
    endRow = totalRowIndex - 1;
  }

  if (endRow - startRow <= 0) {
    console.log("⚠️ Tidak ada data untuk diformat sebagai currency.");
    return;
  }

  // Format kolom sebagai Rp
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

  // Fungsi untuk mengubah colIndex ke AA, AB, dst.
function getColumnLetter(colIndex) {
  let idx = colIndex;
  let letter = '';
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

  const colLetter = getColumnLetter(colIndex);
  const sumRow = endRow + 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!${colLetter}${sumRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[`=SUM(${colLetter}${startRow}:${colLetter}${endRow})`]],
    },
  });

  console.log(`✅ Formula SUM ditulis di baris ${sumRow} kolom ${colLetter}`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: header.length,
            },
          },
        },
      ],
    },
  });

  console.log("✨ Kolom berhasil di-auto-resize");
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
        scrapeProjectWithRetry(pages[idx % BATCH_SIZE], dateLabel, dateStr, project)
      );

      const results = await Promise.all(tasks);
      amounts.push(...results);
    }

    const successCount = amounts.filter((x) => x !== "ERROR").length;
    console.log(
      `📊 Scraping selesai: ${successCount}/${projects.length} projects berhasil.`
    );
    const failCount = amounts.filter((x) => x === "ERROR").length;
    console.log(`📈 Total Berhasil: ${successCount}, Gagal: ${failCount}`);

    
    await uploadToGoogleSheet(projects, amounts, sheetName, dateLabel);

    currentDate = currentDate.add(1, "day");
  }
  await browser.close();
})();
