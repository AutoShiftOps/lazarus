import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache, Suspense } from "react";
import { GhostShell } from "../../../components/GhostShell";
import { GhostSwitch } from "../../../components/GhostSwitch";
import { Heartbeat } from "../../../components/Heartbeat";
import { RulesPanel } from "../../../components/RulesPanel";
import type { StarterOperation } from "../../../lib/ui/starter-rules";
import { Inbox } from "../../../components/Inbox";
import { McpConfig } from "../../../components/McpConfig";
import { TranscriptPanel } from "../../../components/TranscriptPanel";
import { isDemoService } from "../../../lib/auth/owner";
import { SpiritCard } from "../../../components/SpiritCard";
import { isServiceId, registry } from "../../../lib/registry";
import { SOCIAL_IMAGE } from "../../../lib/site-url";
import { originFromHeaders } from "../../../lib/ui/origin";
import {
  ServiceViewError,
  cleanServiceName,
  toServiceView,
  type ServiceView,
  type SpiritView,
} from "../../../lib/ui/service-view";

/** One registry read per request, shared by the page and its metadata. */
const loadService = cache(async (id: string) => {
  // Registry access is request-time data: never let a prerender freeze an error state.
  await connection();
  if (!isServiceId(id)) return { ok: true as const, value: null };
  return registry.getService(id);
});

export async function generateMetadata({ params }: PageProps<"/s/[id]">): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadService(id);
  if (!loaded.ok) return { title: "Lazarus" };
  if (loaded.value === null) return { title: "Lazarus", robots: { index: false, follow: false } };
  const name = cleanServiceName(loaded.value.name);
  if (name === "") return { title: "Lazarus" };
  const title = `${name} spirit`;
  return {
    title,
    openGraph: { type: "website", siteName: "Lazarus", title: `${title} | Lazarus`, images: [SOCIAL_IMAGE] },
    twitter: { card: "summary_large_image", title: `${title} | Lazarus`, images: [{ url: SOCIAL_IMAGE.url, alt: SOCIAL_IMAGE.alt }] },
  };
}

export default function ServicePage({ params }: PageProps<"/s/[id]">) {
  return (
    <Suspense fallback={<ServiceSkeleton />}>
      <ServiceContent params={params} />
    </Suspense>
  );
}

async function ServiceContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadService(id);

  if (!loaded.ok) return <Interrupted />;
  if (loaded.value === null) notFound();

  const origin = originFromHeaders(await headers(), process.env.NODE_ENV === "development");
  let view: ServiceView;
  try {
    if (origin === null) throw new ServiceViewError("INVALID_ORIGIN", "Invalid origin.");
    view = toServiceView({ ...loaded.value, id }, origin);
  } catch (error) {
    if (error instanceof ServiceViewError) notFound();
    throw error;
  }

  return <ServiceDetails view={view} serviceId={id} isDemo={isDemoService(loaded.value)} />;
}

function Interrupted() {
  return (
    <section role="status" className="space-y-3 py-8">
      <h1 className="font-display text-3xl text-text">The séance is interrupted.</h1>
      <p className="max-w-prose text-muted">Try again in a moment.</p>
    </section>
  );
}

function ServiceSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-6">
      <p className="sr-only">The spirits are gathering…</p>
      <div className="h-9 w-2/3 max-w-md animate-pulse rounded-md bg-surface motion-reduce:animate-none" />
      <div className="h-5 w-24 animate-pulse rounded-md bg-surface motion-reduce:animate-none" />
      <div className="h-40 animate-pulse rounded-md bg-surface motion-reduce:animate-none" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((n) => (
          <div key={n} className="h-28 animate-pulse rounded-md bg-surface motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

function groupByPort(spirits: SpiritView[]): { port: string; spirits: SpiritView[] }[] {
  const groups = new Map<string, SpiritView[]>();
  for (const s of spirits) {
    const list = groups.get(s.port);
    if (list) list.push(s);
    else groups.set(s.port, [s]);
  }
  return Array.from(groups, ([port, list]) => ({ port, spirits: list }));
}

function SpiritGrid({ spirits, label, serviceId }: { spirits: SpiritView[]; label: string; serviceId: string }) {
  return (
    <ul aria-label={label} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {spirits.map((s, i) => (
        <SpiritCard key={`${s.port}:${s.name}:${i}`} spirit={s} serviceId={serviceId} index={i} />
      ))}
    </ul>
  );
}

function ServiceDetails({ view, serviceId, isDemo }: { view: ServiceView; serviceId: string; isDemo: boolean }) {
  const count = `${view.operationCount} ${view.operationCount === 1 ? "spirit" : "spirits"}`;
  const groups = groupByPort(view.spirits);
  const operations: StarterOperation[] = view.spirits.map((s) => ({
    name: s.name,
    risk: s.risk,
    inputFields: s.inputDescriptor.map((f) => f.name),
  }));

  return (
    <GhostShell serviceId={serviceId}>
      <header className="space-y-2">
        <h1 className="font-display text-3xl leading-tight text-text sm:text-4xl">{view.name}</h1>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <p className="text-muted">{count}</p>
          <Heartbeat />
        </div>
      </header>

      <section aria-labelledby="endpoint-heading" className="space-y-4 rounded-md border border-border bg-surface p-4 sm:p-6">
        <div className="space-y-1">
          <h2 id="endpoint-heading" className="text-2xl text-text">
            Endpoint
          </h2>
          <p className="max-w-prose text-sm text-muted">
            Point any MCP client at this URL. Every operation below becomes a tool.
          </p>
        </div>
        <McpConfig mcpUrl={view.mcpUrl} clientConfigJson={view.clientConfigJson} cliCommand={view.cliCommand} />
      </section>

      <section aria-labelledby="spirits-heading" className="space-y-4">
        <h2 id="spirits-heading" className="text-2xl text-text">
          Spirits
        </h2>
        {view.spirits.length === 0 ? (
          <p className="text-muted">No spirits answered. This service has no operations.</p>
        ) : groups.length > 1 ? (
          <div className="space-y-8">
            {groups.map((g, i) => (
              <section key={`${g.port}:${i}`} aria-labelledby={`port-${i}`} className="space-y-3">
                <p id={`port-${i}`} className="font-mono text-sm text-muted">
                  Port: {g.port}
                </p>
                <SpiritGrid spirits={g.spirits} label={`Operations on port ${g.port}`} serviceId={serviceId} />
              </section>
            ))}
          </div>
        ) : (
          <SpiritGrid spirits={view.spirits} label="Operations" serviceId={serviceId} />
        )}
      </section>

      <section id="safety" aria-labelledby="safety-heading" className="space-y-6">
        <h2 id="safety-heading" className="text-2xl text-text">
          Safety
        </h2>
        <GhostSwitch />
        <RulesPanel serviceId={serviceId} operations={operations} />
      </section>

      <Inbox serviceId={serviceId} isDemo={isDemo} />
      <TranscriptPanel serviceId={serviceId} isDemo={isDemo} />
    </GhostShell>
  );
}
