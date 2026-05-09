import assert from "node:assert/strict";
import test from "node:test";

import { formatTaskStateETag, parseExpectedTaskStateVersion, taskStateVersion } from "./task-state-version";

test("taskStateVersion derives a stable millisecond version from updatedAt", () => {
  const updatedAt = new Date("2026-05-09T12:34:56.789Z");

  assert.equal(taskStateVersion({ updatedAt }), 1778330096789);
  assert.equal(formatTaskStateETag(1778330096789), '"1778330096789"');
});

test("parseExpectedTaskStateVersion accepts body and HTTP validator formats", () => {
  assert.equal(parseExpectedTaskStateVersion(1778322896789), 1778322896789);
  assert.equal(parseExpectedTaskStateVersion("1778322896789"), 1778322896789);
  assert.equal(parseExpectedTaskStateVersion('"1778322896789"'), 1778322896789);
  assert.equal(parseExpectedTaskStateVersion('W/"1778322896789"'), 1778322896789);
  assert.equal(parseExpectedTaskStateVersion("task:1778322896789"), 1778322896789);
  assert.equal(parseExpectedTaskStateVersion(undefined), undefined);
  assert.equal(parseExpectedTaskStateVersion(""), undefined);
});

test("parseExpectedTaskStateVersion rejects unsafe or invalid versions", () => {
  assert.throws(() => parseExpectedTaskStateVersion("-1"), /non-negative safe integer/);
  assert.throws(() => parseExpectedTaskStateVersion("1.25"), /non-negative safe integer/);
  assert.throws(() => parseExpectedTaskStateVersion("not-a-version"), /non-negative safe integer/);
  assert.throws(() => parseExpectedTaskStateVersion(Number.MAX_SAFE_INTEGER + 1), /non-negative safe integer/);
});
