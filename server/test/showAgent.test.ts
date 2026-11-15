import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ScanCache } from "@artfit/geometry";
import { loadKit } from "../src/adapters/costarKit.js";
import { _ShowStateForTests as ShowState, _buildFinalForTests as buildFinal, runShowTool } from "../src/agent/showAgent.js";
import { validateBrief } from "../src/agent/tools.js";

const env = existsSync(new URL("../../.env", import.meta.url)) ? Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])) : {};
const KIT = process.env.COSTAR_KIT_DIR ?? env.COSTAR_KIT_DIR ?? "";
const brief = { city: "Houston", exhibitionStart: "2027-03-05", exhibitionEnd: "2027-03-21", budget: 6000, budgetCurrency: "USD", artwork: { widthM: 4, depthM: 3, heightM: 2.4 }, preferredClearanceM: 1.5, minimumClearanceM: 1, spaceUsePreferences: ["Flex"], conditions: {},
  works: [{ id: "w-1", title: "Work 1", artist: "A", widthM: 4, depthM: 3, heightM: 2.4, clearanceM: null, required: true }, { id: "w-2", title: "Work 2", artist: "B", widthM: 2, depthM: 1.5, heightM: 1.8, clearanceM: 1.2, required: true }] };

describe.skipIf(!KIT || !existsSync(KIT))("planning agent tools and fact check (CoStar kit snapshot)", async () => {
  const kit = await loadKit(KIT, env.SNAPSHOT_REF_DATE ?? "2026-11-10");
  const ctx = { kit, cache: new ScanCache(), requestId: "t" };
  it("lays out every work without resizing, and the final answer keeps only supported claims", () => {
    const st = new ShowState(kit, validateBrief(brief));
    const s = runShowTool("search_spaces", {}, st, ctx) as any;
    expect(s.spacesWithFloorPlan.length).toBeGreaterThan(0);
    const id = s.spacesWithFloorPlan[0].spaceId;
    const l = runShowTool("plan_group_layout", { spaceId: id, priority: "room", viewingOrder: [] }, st, ctx) as any;
    expect(l.requiredWorksPlaced).toBe("2/2");
    expect(st.works.map((w) => [w.widthM, w.depthM])).toEqual([[4, 3], [2, 1.5]]);
    const final = buildFinal(st, { recommendedSpaceId: id, ranking: [{ spaceId: id, verdict: "recommended", reasons: ["all_required_placed", "required_work_not_placed", "invented_reason"] }] }, "llm");
    expect(final.ranking[0].reasons).toHaveLength(1);
    expect(final.rejected.join(" ")).toMatch(/required_work_not_placed/);
    expect(final.rejected.join(" ")).toMatch(/invented_reason/);
    expect(final.layouts[l.layoutKey].poses["w-1"]).toBeTruthy();
  });
  it("rejects layouts for a space without a floor plan and inquiries before inspection", () => {
    const st = new ShowState(kit, validateBrief(brief));
    const s = runShowTool("search_spaces", {}, st, ctx) as any;
    const tourOnly = s.tourOnlyLeads[0]?.spaceId;
    if (tourOnly) expect(() => runShowTool("plan_group_layout", { spaceId: tourOnly, priority: "room", viewingOrder: [] }, st, ctx)).toThrow(/no traced floor plan/);
    expect(() => runShowTool("draft_inquiry", { spaceId: "x", topics: ["short_term_quote"] }, st, ctx)).toThrow(/Inspect or plan/);
  });
});
