import { assertEquals } from '@std/assert';
import { browserSegmentForRoutingPath } from '../../src/partner/urls.ts';

Deno.test('browserSegmentForRoutingPath strips api/ prefix', () => {
  assertEquals(browserSegmentForRoutingPath('api/clients'), 'clients');
  assertEquals(browserSegmentForRoutingPath('api/'), 'sheet');
});

Deno.test('browserSegmentForRoutingPath slugifies nested paths', () => {
  assertEquals(browserSegmentForRoutingPath('clients'), 'clients');
  assertEquals(browserSegmentForRoutingPath('team/records'), 'team-records');
  assertEquals(browserSegmentForRoutingPath('/leading/trailing/'), 'leading-trailing');
});

Deno.test('browserSegmentForRoutingPath falls back to sheet', () => {
  assertEquals(browserSegmentForRoutingPath('   '), 'sheet');
  assertEquals(browserSegmentForRoutingPath('/'), 'sheet');
});
