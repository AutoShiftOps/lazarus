import type { CSSProperties } from "react";
import { Graveyard } from "../components/Graveyard";
import { LazarusMark } from "../components/LazarusMark";
import { SummonForm } from "../components/SummonForm";

const STEPS = [
  {
    title: "Summon",
    body: "Paste the address of an old SOAP service (a WSDL). Lazarus reads it and turns each operation into a tool, or spirit, that AI agents can use.",
  },
  {
    title: "Commune",
    body: "Try any spirit yourself with a simple form, and watch every call in a transcript.",
  },
  {
    title: "Release",
    body: "Give your agent the MCP link and let it work.",
  },
] as const;

export default function Home() {
  return (
    <div className="space-y-12">
      <section className="gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
        <div className="relative z-10 space-y-6">
          <LazarusMark size={104} className="mb-2 block" />
          <p className="font-display text-lg text-spectral">
            Your dead SOAP service has a pulse again.
          </p>
          <h1 className="fog-in font-display text-3xl leading-tight text-text sm:text-4xl">
            Dead SOAP services, reborn as MCP tools — safely.
          </h1>
          <p className="max-w-prose text-muted">
            Lazarus turns legacy SOAP web services into live MCP servers, so any AI agent can call
            them in plain JSON.
          </p>
          <SummonForm />
        </div>
        <Graveyard className="mx-auto mt-8 w-56 sm:w-72 lg:col-start-2 lg:row-start-1 lg:mt-0 lg:w-full" />
      </section>

      <section aria-labelledby="how-it-works" className="space-y-4">
        <h2 id="how-it-works" className="text-2xl text-text">
          How it works
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="rise rounded-md border border-border bg-surface p-4"
              style={{ ["--i" as string]: i } as CSSProperties}
            >
              <p className="font-display text-lg text-candle">
                {i + 1}. {step.title}
              </p>
              <p className="mt-2 text-sm text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="max-w-prose text-muted">
          Dangerous calls, such as closing an account, are held until a human releases them.
        </p>
      </section>
    </div>
  );
}
