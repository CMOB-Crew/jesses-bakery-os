import ExcelJS from "exceljs";
import { parseColesWorkbook } from "../lib/feeds/coles";

// Same six data rows, expressed in the OLD layout and the NEW one.
const DATA = [
  ["2026-08-25", "NSW", "0819", "COLES LAKE HAVEN",  "3163395", "SOURDOUGH WHITE",  12, 0, 3.10, 37.20],
  ["2026-08-25", "NSW", "706",  "COLES BONDI",       "3534271", "DARK RYE",          5, 0, 4.00, 20.00],
  ["2026-08-25", "NSW", "4166", "COLES MARRICKVILLE","3451243", "CROISSANT",         3, 0, 2.50,  7.50],
  ["2026-08-26", "NSW", "0819", "COLES LAKE HAVEN",  "3163395", "SOURDOUGH WHITE",   9, 0, 3.10, 27.90],
  ["2026-08-26", "NSW", "706",  "COLES BONDI",       "3534271", "DARK RYE",          7, 0, 4.00, 28.00],
  ["2026-08-26", "NSW", "9999", "COLES NOWHERE",     "8888888", "MYSTERY LOAF",      1, 0, 1.00,  1.00],
];

async function oldLayout() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Daily Bakery Supplier Report");
  ws.addRow(["Daily Bakery Supplier Report"]);            // R1 title banner
  ws.addRow([]);                                          // R2 blank
  ws.addRow(["Day","State","Location","Location Description","Sell Item","Sell Item Description","Metrics","Sales Qty","Waste Qty","Std Unit Cost $","Invoice Cost $"]);
  for (const d of DATA) ws.addRow([d[0],d[1],d[2],d[3],d[4],d[5],"",d[6],d[7],d[8],d[9]]);
  ws.addRow(["","","","","Total","","", 37,0,"'--",121.60]);      // per-store subtotal
  ws.addRow(["Grand Total","","","","","","", 37,0,"'--",121.60]); // grand total
  return wb.xlsx.writeBuffer();
}

async function newLayout() {
  const wb = new ExcelJS.Workbook();
  // renamed tab, header on row 1, Metrics column GONE, codes as NUMBERS
  const ws = wb.addWorksheet("Pay on Scan - Daily Report");
  ws.addRow(["Day","State","Location","Location Description","Sell Item","Sell Item Description","Sales Qty","Waste Qty","Std Unit Cost $","Invoice Cost $"]);
  for (const d of DATA) ws.addRow([new Date(d[0] as string), d[1], Number(d[2]), d[3], Number(d[4]), d[5], d[6], d[7], d[8], d[9]]);
  ws.addRow(["","","","","Total","", 37,0,121.60,121.60]);
  ws.addRow(["Grand Total","","","","","", 37,0,121.60,121.60]);
  return wb.xlsx.writeBuffer();
}

function key(r: {saleDate:string;location:string;sellItem:string;salesQty:number}) {
  return `${r.saleDate}|${r.location}|${r.sellItem}|${r.salesQty}`;
}

(async () => {
  const a = await parseColesWorkbook(await oldLayout());
  const b = await parseColesWorkbook(await newLayout());

  console.log("OLD layout →", { sheet: a.sheetName, headerRow: a.headerRow, rows: a.rows.length, rejects: a.rejects.length, from: a.dateFrom, to: a.dateTo });
  console.log("NEW layout →", { sheet: b.sheetName, headerRow: b.headerRow, rows: b.rows.length, rejects: b.rejects.length, from: b.dateFrom, to: b.dateTo });
  console.log();
  console.log("column binding (new):", b.columns);
  console.log();

  const ka = a.rows.map(key).sort();
  const kb = b.rows.map(key).sort();
  const same = JSON.stringify(ka) === JSON.stringify(kb);
  console.log(same ? "PASS — both layouts parse to identical rows" : "FAIL — layouts disagree");
  if (!same) { console.log(" old:", ka); console.log(" new:", kb); }

  console.log();
  console.log("normalised keys from the NEW file (note 0819 and 819 collapse to the same code):");
  for (const r of b.rows) console.log("  ", key(r), " invoice:", r.invoiceCost);

  // The position-based failure their loader hit: if we'd read by column index,
  // the new file's Sales Qty column would land on Waste Qty (all zeros).
  const totalUnits = b.rows.reduce((s, r) => s + r.salesQty, 0);
  console.log();
  console.log("total units parsed from NEW layout:", totalUnits, totalUnits === 37 ? "(correct)" : "(WRONG — would be 0 with a position-based reader)");
})();
