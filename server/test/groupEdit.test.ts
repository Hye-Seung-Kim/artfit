import { describe, expect, it } from "vitest";
import { normalizeGroupResponse } from "../src/agent/groupEdit.js";

const ids = new Set(["w-you", "w-minji-1", "w-minji-2"]);
const op = (o: any) => ({ workIds: [], priority: null, direction: null, distance: null, degrees: null, rotation: null, value: null, ...o });

describe("group edit responses", () => {
  it("accepts lock + rearrange as one request", () => {
    const r = normalizeGroupResponse({ kind: "apply", ops: [op({ op: "lock", workIds: ["w-minji-1"] }), op({ op: "rearrange", priority: "room" })], question: null }, ids);
    expect(r).toEqual({ kind: "apply", ops: [{ op: "lock", workIds: ["w-minji-1"] }, { op: "rearrange", priority: "room" }] });
  });
  it("rejects unknown works, resizing and removal (no such operations)", () => {
    expect(() => normalizeGroupResponse({ kind: "apply", ops: [op({ op: "lock", workIds: ["nope"] })] }, ids)).toThrow(/unknown work/);
    expect(() => normalizeGroupResponse({ kind: "apply", ops: [op({ op: "set_dimension", workIds: ["w-you"] })] }, ids)).toThrow(/not allowed/);
    expect(() => normalizeGroupResponse({ kind: "apply", ops: [op({ op: "remove", workIds: ["w-you"] })] }, ids)).toThrow(/not allowed/);
  });
  it("move needs exactly one work, a direction and a length", () => {
    expect(() => normalizeGroupResponse({ kind: "apply", ops: [op({ op: "move", workIds: ["w-you", "w-minji-1"], direction: "left", distance: { value: 1, unit: "m" } })] }, ids)).toThrow(/one work/);
    expect(() => normalizeGroupResponse({ kind: "apply", ops: [op({ op: "move", workIds: ["w-you"], direction: "left", distance: null })] }, ids)).toThrow(/distance/);
  });
  it("passes a clarifying question through", () => {
    expect(normalizeGroupResponse({ kind: "clarify", ops: [], question: "Which of Minji's two works?" }, ids)).toEqual({ kind: "clarify", question: "Which of Minji's two works?" });
  });
});
