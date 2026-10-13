/** A table of text: a sheet of a workbook, or a CSV file. */
export interface Sheet {
  name: string;
  rows: string[][];
  /** The sheet has more rows or columns than are kept. */
  truncated: boolean;
}

export const MAX_ROWS = 2000;
export const MAX_COLS = 60;

/** Comma, semicolon or tab separated text as a grid. */
export function parseCsv(text: string, tab = false): Sheet {
  const first = text.slice(0, 2000).split(/\r?\n/)[0] ?? '';
  const count = (ch: string) => first.split(ch).length;
  const delimiter =
    tab || count('\t') > Math.max(count(','), count(';'))
      ? '\t'
      : count(';') > count(',')
        ? ';'
        : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  const endField = () => {
    if (row.length < MAX_COLS) row.push(field);
    else truncated = true;
    field = '';
  };
  for (let i = 0; i < text.length && rows.length < MAX_ROWS; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endField();
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (rows.length >= MAX_ROWS) truncated = true;
  else if (field !== '' || row.length > 0) {
    endField();
    rows.push(row);
  }
  return { name: '', rows, truncated };
}
