import { describe, expect, it } from "vitest";
import { checkNumbers } from "../src/agent/report.js";

describe("report narrative number check", () => {
  it("keeps sentences whose numbers come from the facts and drops invented ones", () => {
    const allowed = new Set(["42", "53", "1.25"]);
    const r = checkNumbers("The walk is about 42 m. Up to 53 people can view at once. The ceiling is 4.5 m high. Each work has 1.25 m to spare.", allowed);
    expect(r.text).toBe("The walk is about 42 m. Up to 53 people can view at once. Each work has 1.25 m to spare.");
    expect(r.dropped).toEqual(["The ceiling is 4.5 m high."]);
  });
  it("normalises thousands separators and trailing zeros", () => {
    expect(checkNumbers("About 1,044 spots and 1.50 m.", new Set(["1044", "1.5"])).dropped).toEqual([]);
  });
});
