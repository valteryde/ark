import { columnValueType, resolveSelectLabel } from './cell-value.ts';
import type { CellDisplayStyle, SpreadsheetColumn } from './types.ts';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build safe HTML for a cell from column metadata, raw string value, and backend-enabled styles.
 */
export function formatCellHtml(
  column: SpreadsheetColumn | undefined,
  value: string,
  enabledStyles: ReadonlySet<CellDisplayStyle>,
): string {
  const canonical = value.trim();
  if (!canonical) return '';

  const displayText =
    columnValueType(column) === 'select'
      ? resolveSelectLabel(column, canonical).trim()
      : canonical;
  if (!displayText) return '';

  const requested = column?.displayStyle ?? 'plain';
  if (requested === 'plain' || !enabledStyles.has(requested)) {
    return escapeHtml(displayText);
  }

  if (requested === 'priority') {
    const u = canonical.toUpperCase();
    if (u === 'HIGH' || u === 'MEDIUM' || u === 'URGENT') {
      const key = u.toLowerCase();
      return `<span class="sheet-priority sheet-priority--${key}">${escapeHtml(displayText)}</span>`;
    }
    return escapeHtml(displayText);
  }

  if (requested === 'status') {
    const lower = canonical.toLowerCase();
    if (lower === 'in progress') {
      return `<span class="sheet-status sheet-status--in-progress">${escapeHtml(displayText)}</span>`;
    }
    if (lower === 'not started') {
      return `<span class="sheet-status sheet-status--not-started">${escapeHtml(displayText)}</span>`;
    }
    if (lower === 'completed') {
      return `<span class="sheet-status sheet-status--completed">${escapeHtml(displayText)}</span>`;
    }
    return escapeHtml(displayText);
  }

  if (requested === 'assignee') {
    return `<span class="sheet-assignee"><span class="sheet-assignee-avatar" aria-hidden="true"></span>${escapeHtml(displayText)}</span>`;
  }

  return escapeHtml(displayText);
}
