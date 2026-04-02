import {
  createRoadmapPreset,
  mountFormattingToolbar,
  mountSpreadsheet,
  resolveEnabledUiCapabilities,
} from './spreadsheet';

const sheetHost = document.getElementById('sheet-mount');
const toolbarHost = document.getElementById('formatting-toolbar-mount');
if (!sheetHost) {
  throw new Error('Missing #sheet-mount');
}
if (!toolbarHost) {
  throw new Error('Missing #formatting-toolbar-mount');
}

const preset = createRoadmapPreset();
const sheet = mountSpreadsheet(sheetHost, preset);
mountFormattingToolbar(
  toolbarHost,
  sheet,
  resolveEnabledUiCapabilities(preset.enabledUiCapabilities),
);
