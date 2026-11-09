import assert from "node:assert/strict";
import test from "node:test";
import { isEventVisibleToStudent } from "./eventAudience.js";

test("warns for every mixed-audience event without targets", () => {
  const originalEnvironment = process.env.NODE_ENV;
  const originalWarn = console.warn;
  const warnings = [];
  process.env.NODE_ENV = "development";
  console.warn = (...args) => warnings.push(args);

  try {
    assert.equal(
      isEventVisibleToStudent(
        { title: "IT Akwe", targetAudience: "Mixed Audience" },
        {},
      ),
      true,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /Mixed-audience event "IT Akwe"/);

    assert.equal(
      isEventVisibleToStudent(
        { title: "Malformed event", targetAudience: "Mixed Audience" },
        {},
      ),
      true,
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[1][0], /Mixed-audience event "Malformed event"/);
  } finally {
    console.warn = originalWarn;
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
  }
});
