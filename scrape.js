import { chromium } from 'playwright';
import fs from 'fs';
import dayjs from 'dayjs';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import { google } from 'googleapis';
import 'dotenv/config';

dayjs.extend(isSameOrBefore);

const email = process.env.EMAIL;
const password = process.env.PASSWORD;
const BATCH_SIZE = 10;
const MAX_RETRY = 1;

const projects = JSON.parse(fs.readFileSync('projects.json', 'utf-8'));
const credentials = JSON.parse(fs.readFileSync('credentials.json', 'utf-8'));
const spreadsheetId = '1qd7VoQ79ZJ3aOrXT7omHmjatqWgoINSXsWoYe0IPBTc';

const startDate = dayjs().subtract(1, 'day');
const endDate = startDate;

// const startDate = dayjs("2025-07-01");
// const endDate = dayjs("2025-07-01");

const sheetName = startDate.format('MMMM YYYY'); // Contoh: "July 2025"
const dateHeader = startDate.format('MMMM D');   // Contoh: "July 9"

async function login(page) {
  await page.goto('https://partner.lunahubs.com/login');
  await page.fill('#data\\.email', email);
  await page.fill('#data\\.password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('https://partner.lunahubs.com/', { timeout: 15000 });
  await page.goto('https://partner.lunahubs.com/transaction-reports');
  await page.waitForSelector('text=Transaction Reports', { timeout: 10000 });
}

async function scrapeProject(page, dateLabel, dateStr, project, retry = 0) {
  const encodedDate = encodeURIComponent(dateStr);
  const url = `https://partner.lunahubs.com/transaction-reports?filters[date]=${encodedDate}&filters[projects][0]=${project.id}`;

  try {
    await page.goto(url, { waitUntil: 'networkidle' });

    if (page.url().includes('/login')) {
      if (retry >= MAX_RETRY) throw new Error('Session expired');
      await login(page);
      return await scrapeProject(page, dateLabel, dateStr, project, retry + 1);
    }

    await page.waitForSelector('span.fi-wi-stats-overview-stat-description', { timeout: 10000 });
    const amount = await page.textContent('span.fi-wi-stats-overview-stat-description');
    console.log(`✅ ${project.name} @ ${dateLabel}: ${amount.trim()}`);
    return amount.trim();
  } catch (err) {
    console.error(`❌ ${project.name} @ ${dateLabel}: ERROR`);
    return 'ERROR';
  }
}

async function ensureSheetExists(spreadsheetId, sheetName, sheets) {
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetExists = response.data.sheets.some(
    (s) => s.properties.title === sheetName
  );

  if (!sheetExists) {
    console.log(`📄 Sheet "${sheetName}" belum ada. Membuat baru...`);
    await sheets.spreadsheets.batchUpdate({
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
    console.log(`✅ Sheet "${sheetName}" berhasil dibuat`);
  }
}

async function uploadToGoogleSheet(projects, values, sheetName, columnDate) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  await ensureSheetExists(spreadsheetId, sheetName, sheets);
  // Get existing data
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:Z1000`,
  });  

  let data = res.data.values || [];
  const header = data[0] || ['Name'];
  let colIndex = header.indexOf(columnDate);

  // Tambah header jika belum ada
  if (colIndex === -1) {
    header.push(columnDate);
    colIndex = header.length - 1;
  }
  data[0] = header;

  // Update atau tambah baris
  for (let i = 0; i < projects.length; i++) {
    const name = projects[i].name;
    const idx = data.findIndex(row => row[0] === name);
    if (idx === -1) {
      const newRow = Array(colIndex + 1).fill('');
      newRow[0] = name;
      newRow[colIndex] = values[i];
      data.push(newRow);
    } else {
      data[idx][colIndex] = values[i];
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: data },
  });

  console.log(`✅ Data berhasil diupdate di Google Sheets [${sheetName}]`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const mainPage = await context.newPage();

  await login(mainPage);

  const pages = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const p = await context.newPage();
    await p.goto('https://partner.lunahubs.com/transaction-reports');
    pages.push(p);
  }

  const dateStr = `${startDate.format('YYYY-MM-DD')} - ${endDate.format('YYYY-MM-DD')}`;
  const amounts = [];

  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    const tasks = batch.map((project, idx) =>
      scrapeProject(pages[idx % BATCH_SIZE], dateHeader, dateStr, project)
    );

    const results = await Promise.all(tasks);
    amounts.push(...results);
  }

  const successCount = amounts.filter(x => x !== 'ERROR').length;
  console.log(`📊 Scraping selesai: ${successCount}/${projects.length} projects berhasil.`);
  await uploadToGoogleSheet(projects, amounts, sheetName, dateHeader);
  await browser.close();
})();
