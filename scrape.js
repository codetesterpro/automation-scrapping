import { chromium } from 'playwright';
import fs from 'fs';
import dayjs from 'dayjs';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import xlsx from 'xlsx';
dayjs.extend(isSameOrBefore);
import 'dotenv/config';

const email = process.env.EMAIL;
const password = process.env.PASSWORD;
const startDate = dayjs("2025-07-01");
const endDate = dayjs("2025-07-08");
const BATCH_SIZE = 10;
const MAX_RETRY = 1;

const projects = JSON.parse(fs.readFileSync('projects.json', 'utf-8'));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const loginPage = await context.newPage();

  const errorLog = [];
  const rawResults = [];
  const dateHeaders = [];

  async function login(page) {
    console.log("🔐 Login...");
    await page.goto('https://partner.lunahubs.com/login');
    await page.fill('#data\\.email', email);
    await page.fill('#data\\.password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL('https://partner.lunahubs.com/', { timeout: 15000 });
    await page.goto('https://partner.lunahubs.com/transaction-reports');
    await page.waitForSelector('text=Transaction Reports', { timeout: 10000 });
    console.log("✅ Login berhasil");
  }

  await login(loginPage);

  const pages = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const p = await context.newPage();
    await p.goto('https://partner.lunahubs.com/transaction-reports');
    pages.push(p);
  }

  async function scrapeProject(page, dateLabel, dateStr, project, retry = 0) {
    const encodedDate = encodeURIComponent(dateStr);
    const reportUrl = `https://partner.lunahubs.com/transaction-reports?filters[date]=${encodedDate}&filters[projects][0]=${project.id}`;

    try {
      await page.goto(reportUrl, { waitUntil: 'networkidle' });

      if (page.url().includes('/login')) {
        if (retry >= MAX_RETRY) throw new Error('Session expired after retry.');
        console.warn(`🔐 Session expired @ ${project.name} - retrying login on this tab...`);
        await page.goto('https://partner.lunahubs.com/login');
        await page.fill('#data\\.email', email);
        await page.fill('#data\\.password', password);
        await page.click('button[type="submit"]');
        await page.waitForURL('https://partner.lunahubs.com/', { timeout: 15000 });
        await page.goto('https://partner.lunahubs.com/transaction-reports');
        await page.waitForSelector('text=Transaction Reports', { timeout: 10000 });
        return await scrapeProject(page, dateLabel, dateStr, project, retry + 1);
      }      

      await page.waitForSelector('span.fi-wi-stats-overview-stat-description', { timeout: 10000 });
      const amount = await page.textContent('span.fi-wi-stats-overview-stat-description');
      console.log(`✅ ${project.name} @ ${dateLabel} = ${amount.trim()}`);
      return { date: dateLabel, id: project.id, name: project.name, amount: amount.trim() };
    } catch (err) {
      if (retry < MAX_RETRY) {
        console.warn(`🔁 Retry ${project.name} @ ${dateLabel}...`);
        return await scrapeProject(page, dateLabel, dateStr, project, retry + 1);
      } else {
        const msg = `❌ ${project.name} @ ${dateLabel} GAGAL: ${err.message}`;
        console.error(msg);
        errorLog.push(msg);
        throw err;
      }
    }
  }

  try {
    for (let date = startDate; date.isSameOrBefore(endDate); date = date.add(1, 'day')) {
      const dateStr = `${date.format('YYYY-MM-DD')} - ${date.format('YYYY-MM-DD')}`;
      const dateLabel = date.format('MMMM D');
      dateHeaders.push(dateLabel);
      console.log(`📆 Tanggal: ${dateStr}`);

      for (let i = 0; i < projects.length; i += BATCH_SIZE) {
        const batch = projects.slice(i, i + BATCH_SIZE);

        const tasks = batch.map((project, index) => {
          const thisPage = pages[index % BATCH_SIZE];
          return scrapeProject(thisPage, dateLabel, dateStr, project);
        });

        const results = await Promise.allSettled(tasks);
        for (const res of results) {
          if (res.status === 'fulfilled') {
            rawResults.push(res.value);
          } else {
            throw new Error('⛔ Gagal scraping project, proses dihentikan.');
          }
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ Proses dihentikan lebih awal: ${err.message}`);
  }

  // Generate Excel
  const sheetData = [['Name', ...dateHeaders]];

  for (const project of projects) {
    const row = [project.name];
    for (const date of dateHeaders) {
      const match = rawResults.find(r => r.id === project.id && r.date === date);
      row.push(match ? match.amount : '0');
    }
    sheetData.push(row);
  }

  const fileName = `transactions-report-${startDate.format('YYYY-MM-DD')}-${endDate.format('YYYY-MM-DD')}.xlsx`;
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
  const sheetName = `${startDate.format('YYYY-MM-DD')}_${endDate.format('YYYY-MM-DD')}`;
xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
xlsx.writeFile(workbook, fileName);

  if (errorLog.length > 0) {
    fs.writeFileSync('logError.txt', errorLog.join('\n'));
    console.warn('⚠️ Error dicatat di logError.txt');
    process.exit(1);
  }

  console.log("✅ Semua data selesai & tersimpan");
  await browser.close();
})();
