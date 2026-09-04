// RFC 4180 CSV reader for the cyclone-track lane (reference implementation).
//
// Header row + comma rows; quoted cells with "" escapes; CR LF or LF line ends;
// a blank cell is the empty string (meaning "not reported" downstream). Cells
// are trimmed of surrounding whitespace; the header keys are lower-cased.

export interface CycloneCsv {
  header: string[];
  rows: Record<string, string>[];
}

function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellStarted = false;
  const endCell = (): void => {
    cells.push(cell.trim());
    cell = "";
    cellStarted = false;
  };
  const endLine = (): void => {
    if (cellStarted || cell.length > 0 || cells.length > 0) {
      endCell();
      if (cells.length > 1 || cells.some((value) => value.length > 0)) records.push(cells);
      cells = [];
    }
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      cellStarted = true;
    } else if (c === ",") {
      endCell();
      cellStarted = true;
    } else if (c === "\n") {
      endLine();
    } else if (c !== "\r") {
      cell += c;
      cellStarted = true;
    }
  }
  endLine();
  return records;
}

export function parseCycloneCsv(text: string): CycloneCsv {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = splitRecords(source);
  if (records.length === 0) throw new Error("empty CSV payload");
  const header = records[0].map((name) => name.toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = records[r][c] ?? "";
    rows.push(row);
  }
  return { header, rows };
}
