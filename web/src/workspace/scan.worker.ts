/// <reference lib="webworker" />
// Browser placement scan in ONE Web Worker (spec §7.11). Same pure geometry package as the server.
import { scan, type ScanInput } from "@artfit/geometry";

self.onmessage = (ev: MessageEvent<{ id: number; input: ScanInput }>) => {
  const { id, input } = ev.data;
  try {
    const result = scan(input);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: (e as Error).message });
  }
};
