import { describe, expect, it } from "vitest";
import { normalizeResponse } from "../src/agent/workspaceEdit.js";

const nulls = { direction: null, distance: null, degrees: null, rotation: null, dimension: null, value: null, percent: null, color: null, material: null };
describe("workspace edit response validation", () => {
  it("accepts allowlisted ops with units kept for code-side conversion", () => {
    const r = normalizeResponse({ kind: "apply", question: null, ops: [{ ...nulls, op: "move", direction: "left", distance: { value: 30, unit: "cm" } }, { ...nulls, op: "rotate", degrees: 15, rotation: "clockwise" }] });
    expect(r).toEqual({ kind: "apply", ops: [{ op: "move", direction: "left", distance: { value: 30, unit: "cm" } }, { op: "rotate", degrees: 15, rotation: "clockwise" }] });
  });
  it("rejects ops outside the allowlist (e.g. editing obstacles or running code)", () => {
    expect(() => normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "delete_obstacle" }] })).toThrow();
    expect(() => normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "eval", value: "alert(1)" }] })).toThrow();
  });
  it("rejects malformed values: missing unit, NaN, unknown color, missing direction", () => {
    expect(() => normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "set_elevation", value: { value: 1, unit: "furlong" } }] })).toThrow();
    expect(() => normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "set_dimension", dimension: "width", value: { value: NaN, unit: "m" } }] })).toThrow();
    expect(() => normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "set_finish", color: "gold" }] })).toThrow();
    expect(() => normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "move", distance: { value: 1, unit: "m" } }] })).toThrow();
  });
  it("undo/redo/reset cannot be mixed with other changes", () => {
    expect(() => normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "undo" }, { ...nulls, op: "set_finish", color: "white" }] })).toThrow();
    expect(normalizeResponse({ kind: "apply", ops: [{ ...nulls, op: "reset" }] })).toEqual({ kind: "apply", ops: [{ op: "reset" }] });
  });
  it("clarify passes a question through; empty apply is rejected", () => {
    expect(normalizeResponse({ kind: "clarify", ops: [], question: "How far?" })).toEqual({ kind: "clarify", question: "How far?" });
    expect(() => normalizeResponse({ kind: "apply", ops: [] })).toThrow();
  });
});
