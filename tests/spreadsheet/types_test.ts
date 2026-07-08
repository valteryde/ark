import { assertEquals } from '@std/assert';
import {
  ALL_UI_CAPABILITIES,
  resolveEnabledUiCapabilities,
} from '../../src/spreadsheet/types.ts';

Deno.test('resolveEnabledUiCapabilities defaults to all when undefined', () => {
  const result = resolveEnabledUiCapabilities();
  assertEquals(result, new Set(ALL_UI_CAPABILITIES));
});

Deno.test('resolveEnabledUiCapabilities accepts an array', () => {
  const result = resolveEnabledUiCapabilities(['undo', 'redo']);
  assertEquals(result, new Set(['undo', 'redo']));
});

Deno.test('resolveEnabledUiCapabilities accepts a set', () => {
  const result = resolveEnabledUiCapabilities(new Set(['fill']));
  assertEquals(result, new Set(['fill']));
});

Deno.test('resolveEnabledUiCapabilities on empty array yields empty set', () => {
  assertEquals(resolveEnabledUiCapabilities([]).size, 0);
});
