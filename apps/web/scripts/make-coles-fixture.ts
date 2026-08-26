import ExcelJS from "exceljs";
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Pay on Scan - Daily Report");
ws.addRow(["Day","State","Location","Location Description","Sell Item","Sell Item Description","Sales Qty","Waste Qty","Std Unit Cost $","Invoice Cost $"]);
const rows = [
  ["2026-08-25","NSW",819,"COLES LAKE HAVEN",3163395,"SOURDOUGH WHITE",12,0,3.10,37.20],
  ["2026-08-25","NSW",706,"COLES BONDI",3534271,"DARK RYE",5,0,4.00,20.00],
  ["2026-08-25","NSW",4166,"COLES MARRICKVILLE",3451243,"CROISSANT",3,0,2.50,7.50],
  ["2026-08-26","NSW",819,"COLES LAKE HAVEN",3163395,"SOURDOUGH WHITE",9,0,3.10,27.90],
  ["2026-08-26","NSW",706,"COLES BONDI",3534271,"DARK RYE",7,0,4.00,28.00],
  ["2026-08-26","NSW",9999,"COLES NOWHERE",8888888,"MYSTERY LOAF",1,0,1.00,1.00],
];
for (const r of rows) ws.addRow([new Date(r[0] as string), ...r.slice(1)]);
ws.addRow(["","","","","Total","",37,0,121.60,121.60]);
ws.addRow(["Grand Total","","","","","",37,0,121.60,121.60]);
wb.xlsx.writeFile("/tmp/coles-test.xlsx").then(()=>console.log("wrote /tmp/coles-test.xlsx"));
