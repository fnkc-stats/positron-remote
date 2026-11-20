import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serverReadiness } from '../src/client/update.ts';

const requires = { protocol: 1, capabilities: ['a', 'b'] };

test('a release is offered only when every server that answered has what it needs', () => {
  assert.deepEqual(serverReadiness(requires, [{ host: 'srv', version: '0.4.9', protocol: 1, capabilities: ['a', 'b', 'c'] }]), { behind: [], unknown: [] });
  assert.deepEqual(serverReadiness(requires, [{ host: 'srv', version: '0.4.1', protocol: 1, capabilities: ['a'] }]).behind, ["'srv' (fnkc-ctl 0.4.1)"]);
  assert.deepEqual(serverReadiness(requires, [{ host: 'srv', version: '0.5.0', protocol: 2, capabilities: ['a', 'b'] }]).behind.length, 1);
});

test('unreachable servers are unknown, not behind; releases without requirements are not held back', () => {
  assert.deepEqual(serverReadiness(requires, [{ host: 'srv', error: 'timeout' }]), { behind: [], unknown: ["'srv'"] });
  assert.deepEqual(serverReadiness(undefined, [{ host: 'srv', protocol: 0, capabilities: [] }]), { behind: [], unknown: [] });
});
