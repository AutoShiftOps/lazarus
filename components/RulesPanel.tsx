"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Rule } from "../lib/safety/types";
import { getRules, putRules } from "../lib/ui/rules-client";
import { ruleToEnglish } from "../lib/ui/rule-text";
import {
  isStarterActive,
  MAX_RULES,
  mergeStarter,
  removeStarter,
  starterRules,
  type StarterOperation,
} from "../lib/ui/starter-rules";
import { getOwnerToken } from "../lib/ui/token-store";

interface RulesPanelProps {
  serviceId: string;
  operations: StarterOperation[];
}

const subscribeNever = (): (() => void) => () => undefined;

const FULL_MESSAGE = "The rule list is full. Remove a rule first.";

export function RulesPanel({ serviceId, operations }: RulesPanelProps) {
  // undefined = not read yet (server render and hydration), null = no token.
  const token = useSyncExternalStore(
    subscribeNever,
    () => getOwnerToken(serviceId),
    (): string | null | undefined => undefined,
  );
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const starters = useMemo(() => starterRules(operations), [operations]);

  useEffect(() => {
    const controller = new AbortController();
    void getRules(serviceId, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setRules(result.rules);
      else setError(result.message);
    });
    return () => controller.abort();
  }, [serviceId]);

  const canEdit = typeof token === "string";

  /** Sends the full list. Optimistic; rolls back on failure; one request at a time. */
  const apply = (next: Rule[]): void => {
    if (inFlight.current || rules === null || typeof token !== "string") return;
    if (next.length > MAX_RULES) {
      setError(FULL_MESSAGE);
      return;
    }
    inFlight.current = true;
    const previous = rules;
    setRules(next);
    setBusy(true);
    setError("");
    void putRules(serviceId, next, { ownerToken: token })
      .then((result) => {
        if (result.ok) {
          setRules(result.rules);
        } else {
          setRules(previous);
          setError(result.message);
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <section aria-labelledby="rules-heading" className="space-y-4" aria-busy={busy}>
      <h3 id="rules-heading" className="text-xl text-text">
        Rules
      </h3>

      {rules === null && error === "" ? <p className="text-muted">Gathering the rules…</p> : null}
      {rules !== null && rules.length === 0 ? (
        <p className="text-muted">No rules yet. The spirits follow their defaults: destructive calls are held.</p>
      ) : null}
      {rules !== null && rules.length > 0 ? (
        <ul aria-label="Current rules" className="space-y-2">
          {rules.map((rule, i) => {
            const text = ruleToEnglish(rule);
            return (
              <li
                key={`${rule.id}:${i}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-surface p-3"
              >
                <span className="min-w-0 flex-1 break-words text-sm text-text">{text}</span>
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={`Remove rule: ${text}`}
                    onClick={() => apply(rules.filter((_, idx) => idx !== i))}
                    className="rounded-md border border-border px-3 py-1 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-candle"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {token === null ? <p className="text-sm text-muted">Only the owner can change rules.</p> : null}

      {canEdit && starters.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm uppercase tracking-wide text-muted">Starter rules</h4>
          <ul className="space-y-2">
            {starters.map((starter) => {
              const active = rules !== null && isStarterActive(starter, rules);
              return (
                <li key={starter.id}>
                  <label className="flex items-start gap-3 text-text">
                    <input
                      type="checkbox"
                      checked={active}
                      disabled={rules === null}
                      onChange={() =>
                        rules !== null && apply(active ? removeStarter(rules, starter) : mergeStarter(rules, starter))
                      }
                      className="mt-1 h-4 w-4 accent-candle"
                    />
                    <span>
                      <span className="block">{starter.label}</span>
                      <span className="block text-sm text-muted">{starter.description}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {error !== "" ? (
        <p role="alert" className="text-sm text-vengeful">
          {error}
        </p>
      ) : null}
    </section>
  );
}
