import { mountSheet } from './sheet';

const sheetHost = document.getElementById('sheet-mount');
if (!sheetHost) {
  throw new Error('Missing #sheet-mount');
}
mountSheet(sheetHost);
