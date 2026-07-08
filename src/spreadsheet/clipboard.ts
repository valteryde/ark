/** TSV/HTML clipboard parsing + serialization helpers (pure). */

/** Quote a field for TSV when it contains tab/newline/quote characters. */
export function escapeTsvField(value: string): string {
  if (/[\t\n\r"]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Unquote a single pasted TSV field (reverses {@link escapeTsvField}). */
export function parsePastedCellField(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw;
}

/** Split TSV clipboard text into a grid of unquoted fields, dropping trailing blank lines. */
export function parseClipboardRows(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line) => line.split('\t').map(parsePastedCellField));
}

/**
 * Some clipboard sources (e.g. Google Sheets, Excel-on-web) expose the
 * selection as `text/html` only — a bare `<table>` with <tr>/<td>. When plain
 * text is empty, extract that table into a TSV-shaped string so the paste
 * pipeline can handle it uniformly. Returns `null` if there is no usable table.
 */
export function parseHtmlClipboardTable(html: string): string | null {
  if (!html) return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return null;
  const lines: string[] = [];
  for (const tr of rows) {
    const cells = Array.from(tr.querySelectorAll<HTMLTableCellElement>('th, td'));
    if (cells.length === 0) continue;
    const parts: string[] = [];
    for (const td of cells) {
      const text = (td.innerText ?? td.textContent ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
      parts.push(escapeTsvField(text));
    }
    lines.push(parts.join('\t'));
  }
  if (lines.length === 0) return null;
  return lines.join('\n');
}
