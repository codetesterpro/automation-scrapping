// services/googleSheet.js
import { google } from "googleapis";

/**
 * Pastikan sheet dengan nama sheetName ada.
 * Return: sheetId
 */
async function ensureSheetExists(spreadsheetId, sheetName, sheets) {
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetExists = response.data.sheets.some(
    (s) => s.properties.title === sheetName
  );

  let sheetId;
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
                  rowCount: 2000,
                  columnCount: 200,
                },
              },
            },
          },
        ],
      },
    });
    const newSheet = updateResponse.data.replies[0].addSheet;
    sheetId = newSheet.properties.sheetId;
    console.log(`✅ Sheet "${sheetName}" berhasil dibuat`);
  } else {
    const existingSheet = response.data.sheets.find(
      (s) => s.properties.title === sheetName
    );
    sheetId = existingSheet.properties.sheetId;
  }

  return sheetId;
}

/**
 * Upload hasil scraping ke Google Sheet
 * NOTE: ini versi yang sama seperti di scrape.js,
 * hanya dipindahkan + pakai parameter credentials & spreadsheetId.
 */
export async function uploadToGoogleSheet(
  projects,
  values,
  sheetName,
  columnDate,
  credentials,
  spreadsheetId
) {
    // 🧪 DRY RUN MODE: skip semua operasi ke Google Sheets
  if (process.env.DRY_RUN === "true") {
    console.log("🧪 DRY_RUN aktif — tidak kirim ke Google Sheet");
    console.log("📄 Spreadsheet ID:", spreadsheetId);
    console.log("📑 Sheet:", sheetName, "| Kolom tanggal:", columnDate);
    console.log("📊 Jumlah project:", projects.length);
    console.log(
      "🔍 Sample data:",
      projects.slice(0, 3).map((p, i) => ({
        name: p.name,
        value: values[i],
      }))
    );
    return;
  }


  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const sheetId = await ensureSheetExists(spreadsheetId, sheetName, sheets);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:ZZ1000`,
  });

  let data = res.data.values || [];
  const header = data[0] || ["Name"];
  let colIndex = header.indexOf(columnDate);

  if (colIndex === -1) {
    header.push(columnDate);
    colIndex = header.length - 1;

    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields:
        "sheets(properties(sheetId,gridProperties(columnCount,rowCount)))",
    });
    const sheetMeta = meta.data.sheets.find(
      (s) => s.properties.sheetId === sheetId
    );
    const currentCols =
      sheetMeta?.properties?.gridProperties?.columnCount ?? 26;

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
                    columnCount: header.length,
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

  for (let i = 1; i < data.length; i++) {
    if (data[i].length < header.length) {
      data[i] = [
        ...data[i],
        ...Array(header.length - data[i].length).fill(""),
      ];
    }
  }

  let totalRowIndex = data.findIndex((row) => row[0] === "Total") + 1;

  for (let i = 0; i < projects.length; i++) {
    const name = projects[i].name;
    const idx = data.findIndex((row) => row[0] === name);

    if (idx === -1) {
      const newRow = Array(header.length).fill("");
      newRow[0] = name;
      newRow[colIndex] = values[i];

      if (totalRowIndex > 0) {
        data.splice(totalRowIndex - 1, 0, newRow);
        totalRowIndex++;
      } else {
        data.push(newRow);
      }
    } else {
      if (data[idx].length <= colIndex) {
        data[idx] = [
          ...data[idx],
          ...Array(colIndex + 1 - data[idx].length).fill(""),
        ];
      }
      data[idx][colIndex] = values[i];
    }
  }

  data[0] = header;

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

  function getColumnLetter(colIndex) {
    let idx = colIndex;
    let letter = "";
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
