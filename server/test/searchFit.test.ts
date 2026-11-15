import { describe, expect, it } from "vitest";
import { loadKit } from "../src/adapters/costarKit.js";
import { search_spaces } from "../src/agent/tools.js";
import { ScanCache } from "@artfit/geometry";
import { existsSync, readFileSync } from "node:fs";

// Uses the local CoStar kit snapshot (not in the repo); skipped when it isn't available.
const env = existsSync(new URL("../../.env", import.meta.url)) ? Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])) : {};
const KIT = process.env.COSTAR_KIT_DIR ?? env.COSTAR_KIT_DIR ?? "";

const brief = (over: any = {}) => ({ city: "Houston", exhibitionStart: "2027-03-05", exhibitionEnd: "2027-03-21", budget: null, budgetCurrency: "USD", artwork: { widthM: 4, depthM: 3, heightM: 2.4 }, preferredClearanceM: 1.5, minimumClearanceM: 1, spaceUsePreferences: [], conditions: {}, ...over });

describe.skipIf(!KIT || !existsSync(KIT))("search follows the works (CoStar kit snapshot)", async () => {
  const kit = await loadKit(KIT, env.SNAPSHOT_REF_DATE ?? "2026-11-10");
  const run = (b: any) => search_spaces({ kit, cache: new ScanCache(), requestId: "t" }, b);
  it("ranks listings whose listed ceiling is below the tallest work after those that clear it (none removed)", () => {
    const r = run(brief({ works: [{ id: "a", widthM: 4, depthM: 3, heightM: 2.4 }, { id: "b", widthM: 1, depthM: 1, heightM: 4.2 }] }));
    const passing = r.candidates.filter((c: any) => c.areaScreen !== "below_requested_footprint");
    const firstLow = passing.findIndex((c: any) => c.heightContext === "listed_below_tallest");
    const lastOk = passing.map((c: any) => c.heightContext).lastIndexOf("listed_clears");
    if (firstLow >= 0 && lastOk >= 0) expect(firstLow).toBeGreaterThan(lastOk);
    expect(r.funnel.M1.tallestM).toBe(4.2);
    expect(r.candidates.length).toBe(r.funnel.M.count);
  });
  it("a bigger work changes the area screen; counts come from the kit", () => {
    const small = run(brief()), big = run(brief({ artwork: { widthM: 20, depthM: 15, heightM: 3 } }));
    expect(big.funnel.M1.areaScreen.below_requested_footprint).toBeGreaterThan(small.funnel.M1.areaScreen.below_requested_footprint ?? 0);
    expect(small.candidates[0].requiredAreaM2).toBeGreaterThan(0);
  });
});
