import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addVersion, createVersions, MAX_VERSIONS } from '../js/versions.js';

test('versions: newest first, no repeats, capped', () => {
  const m = new Map();
  const v = createVersions({ get: k => m.get(k), set: (k, x) => m.set(k, x) });
  v.add('a', 'one', 1); v.add('a', 'one', 2); v.add('a', 'two', 3); v.add('b', 'other', 4); v.add('a', '', 5);
  assert.deepEqual(v.list('a'), [{ text: 'two', at: 3 }, { text: 'one', at: 1 }]);
  assert.deepEqual(v.list('none'), []);
  let l = [];
  for (let i = 0; i < MAX_VERSIONS + 5; i++) l = addVersion(l, 't' + i, i);
  assert.equal(l.length, MAX_VERSIONS);
  assert.equal(l[l.length - 1].text, 't' + (MAX_VERSIONS + 4));
});
