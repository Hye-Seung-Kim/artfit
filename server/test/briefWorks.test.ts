import { describe, expect, it } from "vitest";
import { validateBrief } from "../src/agent/tools.js";

const base = { city: "Houston", exhibitionStart: "2027-03-05", exhibitionEnd: "2027-03-21", budget: 8000, budgetCurrency: "USD", artwork: { widthM: 2, depthM: 1.5, heightM: 1.8 }, preferredClearanceM: 1.2, minimumClearanceM: null, spaceUsePreferences: [], conditions: {} };

describe("brief with several works", () => {
  it("keeps the works list (real sizes, ids, artists) for the studio", () => {
    const b = validateBrief({ ...base, works: [{ id: "a", title: "Tide", artist: "Minji", widthM: 2, depthM: 1.5, heightM: 1.8, clearanceM: null }, { id: "b", title: "Column", artist: "Seoyeon", widthM: 0.8, depthM: 0.8, heightM: 2.6, clearanceM: 1 }] });
    expect(b.works).toHaveLength(2);
    expect(b.works![1]).toMatchObject({ id: "b", artist: "Seoyeon", clearanceM: 1, required: true });
    expect(b.artwork).toEqual({ widthM: 2, depthM: 1.5, heightM: 1.8 }); // screening still uses one work
  });
  it("rejects a work without a real size and a solo brief stays as before", () => {
    expect(() => validateBrief({ ...base, works: [{ id: "a", widthM: 0, depthM: 1, heightM: 1 }] })).toThrow(/works\[0\]\.widthM/);
    expect(validateBrief(base).works).toBeUndefined();
  });
});
