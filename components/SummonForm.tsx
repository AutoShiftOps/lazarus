"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { raiseDemo, summonWsdl, type SummonOutcome } from "../lib/ui/summon-client";
import { STAGE_DELAYS_MS, stageLabel, type SummonKind } from "../lib/ui/summon-stages";
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
    clearTimers();
    for (const delay of STAGE_DELAYS_MS) {
      timers.current.push(setTimeout(() => setStage(stageLabel(kind, delay)), delay));
    }
    const fetchFn = (input: string, init?: RequestInit): Promise<Response> => fetch(input, init);
    const outcome: SummonOutcome =
      kind === "demo" ? await raiseDemo(fetchFn) : await summonWsdl(fetchFn, wsdlUrl.trim());
    clearTimers();
    if (outcome.ok) {
      if (outcome.ownerToken) setOwnerToken(outcome.serviceId, outcome.ownerToken);
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
            className={`${buttonBase} border border-spectral bg-surface-raised text-spectral hover:bg-surface`}
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

      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("demo")}
          className={`${buttonBase} bg-candle text-background hover:brightness-110`}
        >
          Raise the Gravewood Bank demo
        </button>
        <p className="mt-2 text-sm text-muted">
          A safe practice bank, created just for you. No WSDL needed.
        </p>
      </div>

      <p aria-live="polite" className="min-h-6 text-spectral">
        {busy ? stage : ""}
      </p>
      <div role="alert" className="text-vengeful">
        {error}
      </div>
    </div>
  );
}
