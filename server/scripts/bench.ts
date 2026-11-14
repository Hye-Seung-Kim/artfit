import fs from "node:fs";
import { scan, AS_SCANNED } from "@artfit/geometry";
for (const f of ["20031202_18036295", "37287981_19233219"]) {
  const a = JSON.parse(fs.readFileSync(`data/annotations/${f}.json`, "utf8"));
  for (const [w, d, rot] of [[4, 3, [0, 90]], [8, 6, [0, 90]], [4, 3, [0, 45, 90, 135]]] as const) {
    const s = scan({ annotation: a, scenario: AS_SCANNED, artwork: { widthM: w, depthM: d }, settings: { gridStepM: 0.1, rotationsDeg: [...rot] } });
    console.log(f, w, d, rot.length, "tested", s.testedCount, "valid", s.validCount, s.scanDurationMs.toFixed(1), "ms", "best", s.bestSampledClearanceM?.toFixed(3));
  }
}
