import { mountPartnerChromeActions } from './chrome-actions.ts';
import { sheetPdfUrl } from './fetch-routing.ts';
import { partnerAuthHeaders } from './partner-token.ts';
import type { PartnerChromeAction } from './types.ts';

export interface SheetHeaderActions {
  path: string;
  pdfExport?: boolean;
  chromeActions?: readonly PartnerChromeAction[];
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1] ?? null;
}

/** Download the sheet PDF from the browser route. */
export async function downloadSheetPdf(path: string): Promise<void> {
  const url = sheetPdfUrl(path);
  const auth = partnerAuthHeaders();
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...(Object.keys(auth).length > 0 ? { headers: auth } : {}),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers.get('Content-Disposition')) ?? 'sheet.pdf';
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function mountPdfExportButton(host: HTMLElement, path: string): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'app-btn app-btn--ghost app-btn--with-icon';
  button.setAttribute('aria-label', 'Export PDF');
  const icon = document.createElement('i');
  icon.className = 'ph ph-file-pdf';
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon, document.createTextNode('Export PDF'));

  const status = document.createElement('span');
  status.className = 'app-chrome__export-status';
  status.setAttribute('aria-live', 'polite');

  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = '';
    void downloadSheetPdf(path)
      .catch(() => {
        status.textContent = 'Could not export PDF';
      })
      .finally(() => {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      });
  });

  host.append(button, status);
}

/**
 * Header actions: Export PDF (on unless `pdfExport` is false) then partner links.
 * An empty `path` leaves the export button off, which is the error and empty states.
 */
export function mountSheetHeaderActions(host: HTMLElement, opts: SheetHeaderActions): void {
  host.replaceChildren();
  if (opts.path && opts.pdfExport !== false) {
    mountPdfExportButton(host, opts.path);
  }
  mountPartnerChromeActions(host, opts.chromeActions, { clear: false });
}
