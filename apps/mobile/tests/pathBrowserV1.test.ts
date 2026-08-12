/**
 * Path-browser navigation tests (plan Part 10): escapes are unrepresentable
 * — navigation composes only validated entry names, `.` names the binding
 * root, and ascending never leaves the root.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  breadcrumbSegmentsV1,
  childPathV1,
  isSafeEntryNameV1,
  parentPathV1,
  ROOT_PATH_V1,
} from '../src/files/pathBrowserV1';

test('descend composes clean relative paths from the root marker', () => {
  const src = childPathV1(ROOT_PATH_V1, 'src');
  assert.equal(src, 'src');
  assert.equal(childPathV1(src as string, 'app'), 'src/app');
});

test('unsafe entry names are not composable: .., separators, NUL, dot, empty', () => {
  for (const name of ['..', '.', '', 'a/b', 'a\\b', 'a\0b']) {
    assert.equal(childPathV1('src', name), null, `name ${JSON.stringify(name)} must not compose`);
    assert.equal(isSafeEntryNameV1(name), false);
  }
  assert.equal(isSafeEntryNameV1('main.ts'), true);
});

test('ascend walks toward the root and never past it', () => {
  assert.equal(parentPathV1('src/app/deep'), 'src/app');
  assert.equal(parentPathV1('src'), ROOT_PATH_V1);
  assert.equal(parentPathV1(ROOT_PATH_V1), ROOT_PATH_V1);
});

test('breadcrumbs render the root marker plus each segment', () => {
  assert.deepEqual(breadcrumbSegmentsV1(ROOT_PATH_V1), ['/']);
  assert.deepEqual(breadcrumbSegmentsV1('src/app'), ['/', 'src', 'app']);
});
