"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { raiseDemo, summonWsdl, type SummonOutcome } from "../lib/ui/summon-client";
import type { AwakeningStage } from "../lib/ui/awakening-state";
import { STAGE_DELAYS_MS, stageKey, stageLabel, type SummonKind } from "../lib/ui/summon-stages";
import { SpiritAwakening } from "./SpiritAwakening";
import { setOwnerToken } from "../lib/ui/token-store";

const EXAMPLES = [
  { name: "Calculator", url: "http://www.dneonline.com/calculator.asmx?WSDL" },
  {
    name: "CountryInfoService",
    url: "http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso?WSDL",
  },
] as const;

const buttonBase =
  "min-h-11 w-full rounded-md px-5 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto";

export function SummonForm() {
  const router = useRouter();
  const [wsdlUrl, setWsdlUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [sceneStage, setSceneStage] = useState<AwakeningStage>("fetching");
  const [error, setError] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTimers(): void {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }

  useEffect(() => clearTimers, []);

  async function run(kind: SummonKind): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    setStage(stageLabel(kind, 0));
    setSceneStage(stageKey(kind, 0));
    clearTimers();
    for (const delay of STAGE_DELAYS_MS) {
      timers.current.push(
        setTimeout(() => {
          setStage(stageLabel(kind, delay));
          setSceneStage(stageKey(kind, delay));
        }, delay),
      );
    }
    const fetchFn = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);
    const outcome: SummonOutcome =
      kind === "demo" ? await raiseDemo(fetchFn) : await summonWsdl(fetchFn, wsdlUrl.trim());
    clearTimers();
    if (outcome.ok) {
      if (outcome.ownerToken) setOwnerToken(outcome.serviceId, outcome.ownerToken);
      setSceneStage("raising");
      router.push(`/s/${outcome.serviceId}`);
      return;
    }
    setStage("");
    setError(outcome.message);
    setBusy(false);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    void run("summon");
  }

  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("demo")}
          className="min-h-14 w-full rounded-md bg-candle px-8 py-3 text-lg font-semibold text-background shadow-[0_0_24px_rgba(246,173,85,0.25)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          Raise the Gravewood Bank demo
        </button>
        <p className="mt-2 text-sm text-muted">
          A safe practice bank, created just for you. No WSDL needed.
        </p>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted">
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <span>or raise your own</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-3" noValidate>
        <label htmlFor="wsdl-url" className="block text-sm font-medium text-text">
          WSDL URL
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="wsdl-url"
            name="wsdlUrl"
            type="url"
            inputMode="url"
            autoComplete="off"
            required
            value={wsdlUrl}
            onChange={(e) => setWsdlUrl(e.target.value)}
            disabled={busy}
            placeholder="https://example.com/service?WSDL"
            className="min-h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 py-2 text-text placeholder:text-muted disabled:opacity-60 sm:flex-1"
          />
          <button
            type="submit"
            disabled={busy}
            className={`${buttonBase} border border-border bg-transparent text-spectral hover:border-spectral hover:bg-surface`}
          >
            Summon
          </button>
        </div>
      </form>

      <div className="space-y-2">
        <p className="text-sm text-muted">Or try an example:</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.name}
              type="button"
              disabled={busy}
              onClick={() => setWsdlUrl(ex.url)}
              className="min-h-11 w-full rounded-md border border-border bg-surface px-4 py-2 text-left text-sm text-text hover:border-spectral disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              {ex.name}
            </button>
          ))}
        </div>
      </div>

      <div aria-live="polite" className="min-h-6">
        {busy ? <SpiritAwakening stage={sceneStage} label={stage} /> : null}
      </div>
      <div role="alert" className="text-vengeful">
        {error}
      </div>
    </div>
  );
}
