// tools/data-parser.ts
// Extracts text from multi-format files (Excel, CSV, MD, TXT).
// Used to provide supplementary context to PM and PO agents.

import * as fs from "fs";
import * as path from "path";
import * as xlsx from "xlsx";

export interface ExtractedData {
  filename: string;
  type: string;
  content: string;
  summary: string; // for structured data (e.g. "Excel file with 3 sheets: Sheet1, Sheet2...")
}

/**
 * Extracts raw text from a file based on its extension.
 */
export async function extractTextFromFile(filePath: string): Promise<ExtractedData> {
  const ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath);

  if (ext === ".xlsx" || ext === ".xls") {
    return parseExcel(filePath, filename);
  }

  if (ext === ".csv") {
    return parseCSV(filePath, filename);
  }

  // Fallback for text-based files
  const content = fs.readFileSync(filePath, "utf8");
  return {
    filename,
    type: ext.slice(1) || "txt",
    content: content.slice(0, 50000), // Cap at 50k chars for LLM context
    summary: `${filename} (${ext.slice(1)}) content`,
  };
}

/**
 * Parses all sheets in an Excel file into a readable text format.
 */
function parseExcel(filePath: string, filename: string): ExtractedData {
  const workbook = xlsx.readFile(filePath);
  let fullText = "";
  const sheets: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    sheets.push(sheetName);
    const worksheet = workbook.Sheets[sheetName];
    // Convert to JSON/CSV for text-based consumption
    const data = xlsx.utils.sheet_to_csv(worksheet);
    fullText += `### Sheet: ${sheetName}\n${data}\n\n`;
  }

  return {
    filename,
    type: "excel",
    content: fullText.slice(0, 50000),
    summary: `Excel file with ${workbook.SheetNames.length} sheets: ${sheets.join(", ")}`,
  };
}

/**
 * Parses CSV files directly.
 */
function parseCSV(filePath: string, filename: string): ExtractedData {
  const content = fs.readFileSync(filePath, "utf8");
  return {
    filename,
    type: "csv",
    content: content.slice(0, 50000),
    summary: `CSV data from ${filename}`,
  };
}

/**
 * Batch extract data from a directory.
 */
export async function extractAllFromDir(dirPath: string): Promise<ExtractedData[]> {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath);
  const results: ExtractedData[] = [];

  for (const file of files) {
    try {
      const res = await extractTextFromFile(path.join(dirPath, file));
      results.push(res);
    } catch (err: any) {
      console.warn(`[data-parser] Failed to parse ${file}: ${err.message}`);
    }
  }

  return results;
}
