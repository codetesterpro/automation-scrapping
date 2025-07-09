# 📄 Dokumentasi: Automation Transaction Scraper

## 🔧 Teknologi yang Digunakan

| Teknologi           | Fungsi                                                                 |
|---------------------|------------------------------------------------------------------------|
| Node.js             | Bahasa pemrograman utama (JavaScript runtime)                          |
| Playwright          | Alat headless browser untuk melakukan scraping data otomatis           |
| Google Sheets API   | Mengirim hasil scraping ke Google Spreadsheet                          |
| GitHub Actions      | Scheduler untuk menjalankan scraping otomatis setiap hari              |
| dayjs               | Library untuk memanipulasi tanggal                                     |
| dotenv              | Memuat variabel lingkungan dari file `.env`                            |

---

## ⚙️ Flow & Mekanisme Kerja

### 1. Login & Navigasi
Scraper login ke website menggunakan akun dari file `.env`.

Setelah login, scraper diarahkan ke halaman laporan transaksi.

---

### 2. Scraping Data
- Scraper mengambil data transaksi berdasarkan proyek dari `projects.json` dan tanggal H-1 (kemarin).
- Pengambilan data menggunakan Playwright dengan metode `goto` dan `page.textContent`.
- Jika scraping gagal karena **session expired** atau **timeout**, sistem akan melakukan **retry 1 kali**.

---

### 3. Format Data
- Data yang berhasil diambil akan disusun dalam bentuk **array 2 dimensi**:
  
  ```js
  [
    ['Name', 'July 8'],
    ['MNP x FIRE', 'Rp 100.000'],
    ...
  ]

### 4. Upload ke Google Sheets
Data dikirim ke Google Spreadsheet berdasarkan bulan. Nama sheet menggunakan format seperti: July 2025.

Mekanisme upload:

✅ Jika sheet belum ada, maka sheet akan dibuat otomatis.

✅ Jika sheet sudah ada, data akan ditambahkan sebagai kolom baru berdasarkan tanggal.

✅ Jika project belum ada di baris, maka baris baru akan dibuat sesuai nama project.

### 5. Scheduler (Otomatis Harian)
Menggunakan GitHub Actions sebagai scheduler untuk scraping otomatis.

⏰ Jadwal: Setiap hari pukul 05:00 WIB

⚙️ Yang dilakukan oleh GitHub Actions:

Menjalankan scrape.js

Mengatur dan menggunakan environment variables

Caching dependencies (node_modules) untuk mempercepat waktu eksekusi

Contoh konfigurasi jadwal (.github/workflows/schedule.yml):

```yaml
schedule:
  - cron: "0 22 * * *" # UTC = 05:00 WIB
