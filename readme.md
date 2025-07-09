📄 Dokumentasi: Automation Transaction Scraper
🔧 Teknologi yang Digunakan
Teknologi	Fungsi
Node.js	Bahasa pemrograman utama (JavaScript runtime)
Playwright	Alat headless browser untuk melakukan scraping data otomatis
Google Sheets API	Mengirim hasil scraping ke Google Spreadsheet
GitHub Actions	Scheduler untuk menjalankan scraping otomatis setiap hari
dayjs	Library untuk memanipulasi tanggal
dotenv	Memuat variabel lingkungan dari file .env

⚙️ Flow & Mekanisme Kerja
1. Login & Navigasi
Scraper login ke https://partner.lunahubs.com/login menggunakan akun dari .env.

Setelah login, scraper diarahkan ke halaman laporan transaksi.

2. Scraping Data
Scraper mengambil data transaksi berdasarkan proyek (projects.json) dan tanggal (H-1).

Data diambil menggunakan Playwright dengan metode goto dan page.textContent.

Jika scraping gagal (Session expired atau Timeout), dilakukan retry 1 kali.

3. Format Data
Data dikumpulkan dalam bentuk array 2D: [['Name', 'July 8'], ['MNP x FIRE', 'Rp 100.000'], ...].

4. Upload ke Google Sheets
Data dikirim ke spreadsheet berdasarkan bulan (sheetName = "July 2025").

Jika sheet belum ada, otomatis akan dibuat.

Jika sheet sudah ada, data akan di-append sebagai kolom baru (per tanggal).

Jika project belum ada di baris, akan dibuat baris baru.

5. Scheduler
Menggunakan GitHub Actions:

Jadwal: Setiap hari pukul 05:00 WIB.

Runner akan menjalankan scrape.js secara otomatis.

Dependencies akan dicache untuk mempercepat build.

🔐 Environment Variables
Variable	Deskripsi
EMAIL	Email login Playwright
PASSWORD	Password login Playwright
GOOGLE_SERVICE_KEY_BASE64	Hasil credentials.json yang di-base64-kan untuk Sheets API
