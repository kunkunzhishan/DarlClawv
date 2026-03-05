import test from "node:test";
import assert from "node:assert/strict";
import { extractSelfReport } from "../src/core/iteration/worker-report.js";

test("extractSelfReport parses sections and strips them from user output", () => {
  const input = [
    "Completed partial work",
    "## ERROR_REASON",
    "Missing permission",
    "## THINKING",
    "Need higher profile",
    "## NEXT_ACTION",
    "Request workspace"
  ].join("\n");

  const { report, userFacingOutput } = extractSelfReport(input);
  assert.equal(report.errorReason, "Missing permission");
  assert.equal(report.thinking, "Need higher profile");
  assert.equal(report.nextAction, "Request workspace");
  assert.equal(userFacingOutput, "Completed partial work");
});

test("extractSelfReport returns original text when no sections", () => {
  const input = "All done.";
  const { report, userFacingOutput } = extractSelfReport(input);
  assert.equal(report.hadSections, false);
  assert.equal(userFacingOutput, "All done.");
});
