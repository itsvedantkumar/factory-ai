import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvironmentFile } from "../src/environment-file.js";

test("parses environment values containing spaces and equals without shell evaluation", () => {
  assert.deepEqual(parseEnvironmentFile("FACTORY_NAME=My Factory\nFACTORY_PURPOSE=Ship secure = reviewed software\n"), {
    FACTORY_NAME: "My Factory",
    FACTORY_PURPOSE: "Ship secure = reviewed software",
  });
  assert.throws(() => parseEnvironmentFile("BAD KEY=value\n"), /Invalid environment key/);
  assert.throws(() => parseEnvironmentFile("A=one\nA=two\n"), /Duplicate environment key/);
});
