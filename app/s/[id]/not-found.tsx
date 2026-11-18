import Link from "next/link";

export default function NotFound() {
  return (
    <section className="space-y-4 py-8">
      <h1 className="font-display text-3xl text-text">This spirit has passed on.</h1>
      <p className="max-w-prose text-muted">
        No service lives at this address. It may never have been raised, or it has since faded.
      </p>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center rounded-md bg-candle px-4 py-2 font-medium text-background hover:brightness-110"
      >
        Return home
      </Link>
    </section>
  );
}
