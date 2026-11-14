import { useEffect, useRef, useState } from "react";
import type { ScanInput, ScanResult } from "@artfit/geometry";

/** Runs scans in a single worker; drops any result whose id is not the latest request (stale protection). */
export function useWorkerScan(input: ScanInput | null) {
  const worker = useRef<Worker | null>(null);
  const latest = useRef(0);
  const [state, setState] = useState<{ result: ScanResult | null; busy: boolean; error: string | null }>({ result: null, busy: false, error: null });
  useEffect(() => {
    worker.current = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });
    worker.current.onmessage = (ev: MessageEvent<{ id: number; result?: ScanResult; error?: string }>) => {
      if (ev.data.id !== latest.current) return; // stale
      setState({ result: ev.data.result ?? null, busy: false, error: ev.data.error ?? null });
    };
    return () => worker.current?.terminate();
  }, []);
  const key = input ? JSON.stringify([input.annotation.annotationId, input.annotation.version, input.scenario.id, input.scenario.version, input.artwork, input.settings]) : "";
  useEffect(() => {
    if (!input || !worker.current) return;
    const id = ++latest.current;
    setState((s) => ({ ...s, busy: true }));
    const t = setTimeout(() => worker.current?.postMessage({ id, input }), 60); // small debounce while dragging
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
