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
  const v = value.trim();
  if (!v) return '';

  const requested = column?.displayStyle ?? 'plain';
  if (requested === 'plain' || !enabledStyles.has(requested)) {
    return escapeHtml(v);
  }

  if (requested === 'priority') {
    const u = v.toUpperCase();
    if (u === 'HIGH' || u === 'MEDIUM' || u === 'URGENT') {
      const key = u.toLowerCase();
      return `<span class="sheet-priority sheet-priority--${key}">${escapeHtml(v)}</span>`;
    }
    return escapeHtml(v);
  }

  if (requested === 'status') {
    const lower = v.toLowerCase();
    if (lower === 'in progress') {
      return `<span class="sheet-status sheet-status--in-progress">${escapeHtml(v)}</span>`;
    }
    if (lower === 'not started') {
      return `<span class="sheet-status sheet-status--not-started">${escapeHtml(v)}</span>`;
    }
    if (lower === 'completed') {
      return `<span class="sheet-status sheet-status--completed">${escapeHtml(v)}</span>`;
    }
    return escapeHtml(v);
  }

  if (requested === 'assignee') {
    return `<span class="sheet-assignee"><span class="sheet-assignee-avatar" aria-hidden="true"></span>${escapeHtml(v)}</span>`;
  }

  return escapeHtml(v);
}
