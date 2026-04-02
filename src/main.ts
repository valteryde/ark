import {
  createRoadmapArchivePreset,
  createRoadmapBacklogPreset,
  createRoadmapPreset,
  mountFormattingToolbar,
  mountSpreadsheet,
  resolveEnabledUiCapabilities,
} from './spreadsheet';

const sheetMountEl = document.getElementById('sheet-mount');
const toolbarMountEl = document.getElementById('formatting-toolbar-mount');
const sheetPanelEl = document.getElementById('sheet-panel');
const tablist = document.querySelector<HTMLElement>('.app-sheet-tabs[role="tablist"]');

if (!sheetMountEl) {
  throw new Error('Missing #sheet-mount');
}
if (!toolbarMountEl) {
  throw new Error('Missing #formatting-toolbar-mount');
}
if (!sheetPanelEl) {
  throw new Error('Missing #sheet-panel');
}
if (!tablist) {
  throw new Error('Missing sheet tab list');
}

const sheetHost: HTMLElement = sheetMountEl;
const toolbarHost: HTMLElement = toolbarMountEl;
const sheetPanel: HTMLElement = sheetPanelEl;

const SHEET_VIEWS = [
  { id: 'quarterly', create: createRoadmapPreset },
  { id: 'backlog', create: createRoadmapBacklogPreset },
  { id: 'archive', create: createRoadmapArchivePreset },
] as const;

const tabButtons = SHEET_VIEWS.map((v) => {
  const el = tablist.querySelector<HTMLButtonElement>(`[data-sheet-view="${v.id}"]`);
  if (!el) throw new Error(`Missing tab for sheet view: ${v.id}`);
  return el;
});

function remountActiveSheet(viewIndex: number): void {
  const view = SHEET_VIEWS[viewIndex];
  if (!view) return;

  const config = view.create();
  sheetHost.replaceChildren();
  const sheet = mountSpreadsheet(sheetHost, config);

  toolbarHost.replaceChildren();
  mountFormattingToolbar(
    toolbarHost,
    sheet,
    resolveEnabledUiCapabilities(config.enabledUiCapabilities),
  );
}

let activeViewIndex = -1;

function setActiveTab(index: number): void {
  if (index === activeViewIndex) return;
  activeViewIndex = index;

  tabButtons.forEach((btn, i) => {
    const on = i === index;
    btn.classList.toggle('app-sheet-tabs__tab--active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
    if (on) {
      sheetPanel.setAttribute('aria-labelledby', btn.id);
    }
  });
  remountActiveSheet(index);
}

tabButtons.forEach((btn, index) => {
  btn.addEventListener('click', () => setActiveTab(index));
});

tablist.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
    return;
  }
  const current = tabButtons.findIndex((b) => b.classList.contains('app-sheet-tabs__tab--active'));
  if (current < 0) return;

  let next = current;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabButtons.length - 1;
  else if (e.key === 'ArrowLeft') next = current <= 0 ? tabButtons.length - 1 : current - 1;
  else if (e.key === 'ArrowRight') next = current >= tabButtons.length - 1 ? 0 : current + 1;

  if (next !== current) {
    e.preventDefault();
    setActiveTab(next);
    tabButtons[next]?.focus();
  }
});

setActiveTab(0);
