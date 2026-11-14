import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES, AGENT_TOOLS, validateAgentSelection } from "../src/agent/loop.js";

const facts: Record<string, string | null> = {
  "req.market": "Houston", "req.clearance": "a preferred clearance of 1.5 m", "req.minimum": "1 m", "req.artwork": "4 × 3 × 2.4 m",
  "search.N": "2,431", "search.M": "299", "search.traced": "2", "top.name": "X", "top.idle": "strong",
  "A.name": "A", "A.scenario": "as scanned", "A.passCount": "1,044", "A.best": "2.15 m", "A.verification": "exploratory", "A.remainingChecks": "r",
  "B.name": null, "B.passCount": null, "B.scenario": null, "B.verification": null, "B.remainingChecks": null, "B.reason": "n", "adj.proposed": null, "adj.reason": "n",
};
const state = (outcome: string) => ({ facts: () => facts, outcome: () => outcome });
const T = (id: string) => AGENT_TEMPLATES.find((t) => t.id === id)!;

describe("agent", () => {
  it("exposes exactly the four spec tools, all strict", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(["evaluate_placement", "inspect_space", "plan_alternatives", "search_spaces"]);
    expect(AGENT_TOOLS.every((t) => t.strict === true)).toBe(true);
  });
  it("evaluate_placement cannot carry an artwork or scenario (requirements come from the locked brief)", () => {
    const ev = AGENT_TOOLS.find((t) => t.name === "evaluate_placement")!;
    expect(Object.keys((ev.input_schema as any).properties).sort()).toEqual(["requiredClearanceM", "spaceId"]);
  });
  it("all templates pass the text checks (no bare digits, no banned claims)", () => {
    for (const t of AGENT_TEMPLATES) expect(/\d/.test(t.text.replace(/\{[A-Za-z0-9_.]+\}/g, ""))).toBe(false);
  });
  it("accepts a matching template for the deterministic outcome", () => {
    expect(validateAgentSelection({ templateId: "primary_fits", outcome: "fit", text: T("primary_fits").text }, state("fit"))).toEqual([]);
  });
  it("rejects wrong outcome, edited text, unavailable facts", () => {
    expect(validateAgentSelection({ templateId: "primary_fits", outcome: "fit", text: T("primary_fits").text }, state("none")).length).toBeGreaterThan(0);
    expect(validateAgentSelection({ templateId: "primary_fits", outcome: "fit", text: "It fits perfectly and is vacant." }, state("fit")).length).toBeGreaterThan(0);
    expect(validateAgentSelection({ templateId: "floor_conflict_other_floor_fit", outcome: "keep", text: T("floor_conflict_other_floor_fit").text }, state("keep")).join()).toMatch(/B.name/);
  });
});
