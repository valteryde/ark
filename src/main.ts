import { createRoadmapPreset, mountSpreadsheet } from './spreadsheet';

const sheetHost = document.getElementById('sheet-mount');
if (!sheetHost) {
  throw new Error('Missing #sheet-mount');
}
mountSpreadsheet(sheetHost, createRoadmapPreset());
