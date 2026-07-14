import test from "node:test";
import assert from "node:assert/strict";
import { submissionId } from "../src/submission-id.js";

test("retries reuse a deterministic objective ID unless force-new is explicit", () => {
  const first = submissionId("acme/app", "Ship safely");
  assert.equal(submissionId("acme/app", "Ship safely"), first);
  assert.notEqual(submissionId("acme/app", "Ship safely", { forceNew: true }), first);
});
