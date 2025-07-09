import fs from 'fs';

// Baca isi HTML dari file
const htmlContent = fs.readFileSync('list-project.html', 'utf-8');

// Regex untuk ambil ID proyek (#647, #123, dll)
const idPattern = /<span\s+class="fi-ta-text-item-label[^>]*>\s*#(\d+)\s*<\/span>/g;

// Regex untuk ambil nama proyek (berdasarkan urutan setelah ID)
const namePattern = /<span\s+class="fi-ta-text-item-label[^>]*>\s*(?!#)([^<]+?)\s*<\/span>/g;

// Ambil semua ID
const projectIds = [];
let matchId;
while ((matchId = idPattern.exec(htmlContent)) !== null) {
  projectIds.push(matchId[1]);
}

// Ambil semua nama
const projectNames = [];
let matchName;
while ((matchName = namePattern.exec(htmlContent)) !== null) {
  projectNames.push(matchName[1].trim());
}

// Gabungkan hasil: Asumsikan urutan ID dan nama berurutan
const projects = [];
const len = Math.min(projectIds.length, projectNames.length);
for (let i = 0; i < len; i++) {
  projects.push({
    id: projectIds[i],
    name: projectNames[i]
  });
}

// Tampilkan hasil di console
projects.forEach((p, idx) => {
  console.log(`Proyek ${idx + 1}:`);
  console.log(`ID: ${p.id}`);
  console.log(`Nama: ${p.name}`);
  console.log('-'.repeat(30));
});

// Simpan ke file JSON
fs.writeFileSync('projects.json', JSON.stringify(projects, null, 2));
console.log(`✅ ${projects.length} project berhasil disimpan ke projects.json`);
