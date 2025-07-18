import { chromium } from "playwright";
import fs from "fs";
import "dotenv/config";

const email = process.env.EMAIL;
const password = process.env.PASSWORD;
const PROJECTS_FILE = "projects.json";
const TARGET_URL = "https://partner.lunahubs.com/projects";

async function login(page) {
  await page.goto("https://partner.lunahubs.com/login");
  await page.fill("#data\\.email", email);
  await page.fill("#data\\.password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL("https://partner.lunahubs.com/");
}

async function fetchProjects(page) {
  await page.goto(TARGET_URL);
  await page.screenshot({ path: "before-wait-table.png" });
  await page.waitForSelector("table.fi-ta-table");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "after-wait-table.png" });

  const projects = await page.$$eval("table.fi-ta-table tbody tr", (rows) =>
    rows.map((row) => {
        const columns = row.querySelectorAll("td");
        const id = columns[0]?.innerText.trim().replace(/#/g, '');
        const nameElement = columns[2]?.querySelector('span');
        const name = nameElement ? nameElement.textContent.trim() : '';



      // Ambil teks langsung dari child pertama kolom kedua
        // let nameElement = columns[1]?.querySelector('span');
        // let rawName = nameElement ? nameElement.textContent.trim() : '';

      return { id, name };
    }).filter(p => p.id && p.name)
  );
  return projects;
}


function mergeProjects(existingProjects, scrapedProjects) {
  // Normalize ID existing projects (hapus simbol # jika ada)
  const existingProjectIds = existingProjects.map(p => String(p.id).replace(/#/g, ''));

  // Filter hanya project yang ID-nya belum ada di existing
  const newProjects = scrapedProjects.filter(p => {
    const normalizedId = String(p.id).replace(/#/g, '');
    return !existingProjectIds.includes(normalizedId);
  });

  if (newProjects.length === 0) {
    console.log("✅ Tidak ada project baru ditemukan.");
    return;
  }

  const updated = [...existingProjects, ...newProjects];
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(updated, null, 2));
  console.log(`✅ ${newProjects.length} project baru ditambahkan ke ${PROJECTS_FILE}.`);
}


(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await login(page);

  console.log("📦 Mengambil daftar project...");
  const scraped = await fetchProjects(page);
  console.log('Scraped Projects:', scraped);

  let existing = [];
  if (fs.existsSync(PROJECTS_FILE)) {
    existing = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
  }

  mergeProjects(existing, scraped);
  await browser.close();
})();
