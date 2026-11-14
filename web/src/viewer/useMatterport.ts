// Shared Showcase SDK connection (Workspace scan view + annotation tool).
// A plain iframe carrying `applicationKey` waits for an SDK handshake and stays black, so every keyed
// embed must go through setupSdk. If the SDK cannot connect, we fall back to a key-less view-only iframe.
import { useEffect, useRef, useState } from "react";
import { setupSdk, type MpSdk } from "@matterport/sdk";

export const MP_DOMAIN = (import.meta.env.VITE_MATTERPORT_DOMAIN as string | undefined) ?? "my.matterport.com";
const SDK_KEY = import.meta.env.VITE_MATTERPORT_SDK_KEY as string | undefined;
const CONNECT_TIMEOUT_MS = 25_000;

export type MpStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; domain: string; phase: string }
  | { kind: "fallback"; reason: string } // view-only, no SDK
  | { kind: "error"; reason: string };

export function viewOnlyUrl(modelId: string) {
  return `https://${MP_DOMAIN}/show/?${new URLSearchParams({ m: modelId, play: "1", qs: "1" })}`;
}

export function useMatterport(modelId: string | null | undefined, attempt = 0) {
  const container = useRef<HTMLDivElement>(null);
  const [sdk, setSdk] = useState<MpSdk | null>(null);
  const [status, setStatus] = useState<MpStatus>({ kind: "idle" });

  useEffect(() => {
    const el = container.current;
    if (!modelId || !el) return;
    let cancelled = false;
    let connected: MpSdk | null = null;
    let phaseSub: { cancel(): void } | null = null;
    setSdk(null);
    if (!SDK_KEY) { setStatus({ kind: "fallback", reason: "VITE_MATTERPORT_SDK_KEY is not set" }); return; }
    setStatus({ kind: "connecting" });
    el.innerHTML = "";
    // Defer the connect so a mount→unmount→mount sequence (React StrictMode, fast A/B switches) starts only ONE
    // SDK session. Two overlapping setupSdk calls leave the visible iframe bound to a disconnected session.
    const startTimer = setTimeout(() => { if (!cancelled) start(); }, 80);
    const start = () => {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no SDK handshake within ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS));
    Promise.race([
      setupSdk(SDK_KEY, {
        space: modelId, container: el, domain: MP_DOMAIN,
        iframeQueryParams: { qs: 1, play: 1 },
        // No iframeAttributes: overriding the SDK's own iframe attributes left the Showcase canvas black.
        // Sizing is done in CSS (.mp-host iframe).
      }),
      timeout,
    ])
      .then((mp) => {
        connected = mp;
        if (cancelled) { try { mp.disconnect(); } catch { /* ignore */ } return; }
        if (import.meta.env.DEV) (window as any).__mpSdk = mp; // dev-only debugging handle
        setSdk(mp);
        setStatus({ kind: "connected", domain: MP_DOMAIN, phase: "loading" });
        // Track the Showcase app phase so "connected" is not shown as if the scan were already visible.
        phaseSub = (mp as any).App.state.subscribe((st: any) => {
          if (cancelled) return;
          const phase = String(st?.phase ?? "").replace("appphase.", "") || "unknown";
          setStatus({ kind: "connected", domain: MP_DOMAIN, phase });
        });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        console.warn("[artfit] Matterport SDK connect failed:", e.message);
        el.innerHTML = "";
        setStatus({ kind: "fallback", reason: e.message });
      });
    };
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      phaseSub?.cancel();
      if (connected) { try { connected.disconnect(); } catch { /* ignore */ } }
      el.innerHTML = "";
    };
  }, [modelId, attempt]);

  return { container, sdk, status };
}

export type Sweep = { sid: string; position: { x: number; y: number; z: number } };

/** Subscribe to the model's sweeps (viewpoints). */
export function useSweeps(sdk: MpSdk | null) {
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  useEffect(() => {
    if (!sdk) { setSweeps([]); return; }
    const sub = sdk.Sweep.data.subscribe({
      onCollectionUpdated(c: Record<string, any>) {
        setSweeps(Object.entries(c).map(([sid, s]) => ({ sid: s.sid ?? sid, position: s.position })));
      },
    } as any);
    return () => sub.cancel();
  }, [sdk]);
  return sweeps;
}
