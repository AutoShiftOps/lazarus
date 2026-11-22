"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { buildZodSchema } from "../lib/soap/schema-generator";
import type { FieldDescriptor } from "../lib/soap/types";
import {
  callTool,
  collectResult,
  COMMUNE_MESSAGES,
  type CommuneResult,
  type FetchLike,
} from "../lib/ui/commune-client";
import { FormError, toArguments, toFormModel, type FormField } from "../lib/ui/form-model";

export const MAX_RESULT_CHARS = 20_000;

type FlatValues = Record<string, string | boolean>;
type Errors = Record<string, string>;
type Phase = "idle" | "waiting" | "collecting";

interface CommuneFormProps {
  serviceId: string;
  toolName: string;
  inputDescriptor: FieldDescriptor[];
  /** Test seam: defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

const ROOT_KEY = "";
const MSG_REQUIRED = "This field is required.";

function childPath(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}.${name}`;
}

/** Nested raw values from the flat per-path state, in the shape `toArguments` expects. */
function nestValues(model: FormField[], flat: FlatValues, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of model) {
    const path = childPath(prefix, field.name);
    if (field.kind === "group" && !field.list) {
      out[field.name] = nestValues(field.children, flat, path);
    } else if (path in flat) {
      out[field.name] = flat[path];
    } else if (field.kind === "boolean" && field.required && !field.list) {
      out[field.name] = false;
    }
  }
  return out;
}

function isBlank(value: string | boolean | undefined): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

/** Required leaf and list fields that were left empty. Required groups are checked through their children. */
function requiredErrors(model: FormField[], flat: FlatValues, prefix: string, out: Errors): void {
  for (const field of model) {
    const path = childPath(prefix, field.name);
    if (field.kind === "group" && !field.list) {
      requiredErrors(field.children, flat, path, out);
      continue;
    }
    if (!field.required || field.kind === "boolean") continue;
    // A required list may be left empty: toArguments sends [] for it.
    if (field.list) continue;
    if (isBlank(flat[path])) out[path] = MSG_REQUIRED;
  }
}

function fieldPaths(model: FormField[], prefix: string, out: Set<string>): void {
  for (const field of model) {
    const path = childPath(prefix, field.name);
    out.add(path);
    if (field.kind === "group" && !field.list) fieldPaths(field.children, path, out);
  }
}

/** Maps a zod issue path onto the closest rendered field (list items map to the list field). */
function issueField(path: PropertyKey[], known: Set<string>): string | null {
  const parts: string[] = [];
  for (const p of path) {
    if (typeof p === "number") break;
    parts.push(String(p));
  }
  while (parts.length > 0) {
    const candidate = parts.join(".");
    if (known.has(candidate)) return candidate;
    parts.pop();
  }
  return null;
}

type Validation = { ok: true; args: unknown } | { ok: false; errors: Errors };

export function validateCommune(descriptor: FieldDescriptor[], flat: FlatValues): Validation {
  const model = toFormModel(descriptor);
  const errors: Errors = {};
  requiredErrors(model, flat, "", errors);

  let args: unknown;
  try {
    args = toArguments(model, nestValues(model, flat, ""));
  } catch (error) {
    if (error instanceof FormError) {
      if (!(error.field in errors)) errors[error.field] = error.message.replace(`${error.field}: `, "");
    } else {
      errors[ROOT_KEY] = "These values could not be read.";
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = buildZodSchema(descriptor).safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data };

  const known = new Set<string>();
  fieldPaths(model, "", known);
  for (const issue of parsed.error.issues) {
    const target = issueField(issue.path, known) ?? ROOT_KEY;
    if (!(target in errors)) errors[target] = issue.message;
  }
  return { ok: false, errors };
}

function formatJson(data: unknown): string {
  let text: string;
  if (typeof data === "string") text = data;
  else {
    try {
      text = JSON.stringify(data, null, 2) ?? String(data);
    } catch {
      text = String(data);
    }
  }
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated]` : text;
}

function inputType(kind: FormField["kind"]): string {
  if (kind === "number") return "number";
  if (kind === "datetime") return "datetime-local";
  if (kind === "date") return "date";
  return "text";
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-text placeholder:text-muted";

interface FieldProps {
  field: FormField;
  path: string;
  idBase: string;
  flat: FlatValues;
  errors: Errors;
  disabled: boolean;
  onChange: (path: string, value: string | boolean) => void;
}

function fieldId(idBase: string, path: string): string {
  return `${idBase}-${path}`;
}

function FieldLabel({ field, htmlFor }: { field: FormField; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="block break-words font-mono text-sm text-text">
      {field.name}
      {field.required ? (
        <>
          <span aria-hidden="true" className="text-candle">
            {" "}
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </label>
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={id} className="text-sm text-vengeful">
      {message}
    </p>
  );
}

function FieldView(props: FieldProps) {
  const { field, path, idBase, flat, errors, disabled, onChange } = props;
  const id = fieldId(idBase, path);
  const errorId = `${id}-error`;
  const error = errors[path];
  const describedBy = error === undefined ? undefined : errorId;
  const common = {
    id,
    disabled,
    "aria-required": field.required ? (true as const) : undefined,
    "aria-invalid": error === undefined ? undefined : (true as const),
    "aria-describedby": describedBy,
  };

  if (field.kind === "group" && !field.list) {
    return (
      <fieldset className="min-w-0 space-y-3 rounded-md border border-border p-3" aria-describedby={describedBy}>
        <legend className="px-1 font-mono text-sm text-spectral">
          {field.name}
          {field.required ? <span className="sr-only"> (required)</span> : null}
          {field.required ? (
            <span aria-hidden="true" className="text-candle">
              {" "}
              *
            </span>
          ) : null}
        </legend>
        <FieldError id={errorId} message={error} />
        {field.children.map((child) => (
          <FieldView key={child.name} {...props} field={child} path={childPath(path, child.name)} />
        ))}
      </fieldset>
    );
  }

  if (field.list) {
    const raw = flat[path];
    return (
      <div className="space-y-1">
        <FieldLabel field={field} htmlFor={id} />
        <textarea
          {...common}
          rows={3}
          value={typeof raw === "string" ? raw : ""}
          placeholder="JSON array, for example [1, 2]"
          onChange={(e) => onChange(path, e.target.value)}
          className={`${inputClass} font-mono`}
        />
        <FieldError id={errorId} message={error} />
      </div>
    );
  }

  if (field.kind === "boolean") {
    const raw = flat[path];
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <input
            {...common}
            type="checkbox"
            checked={raw === true}
            onChange={(e) => onChange(path, e.target.checked)}
          />
          <FieldLabel field={field} htmlFor={id} />
        </div>
        <FieldError id={errorId} message={error} />
      </div>
    );
  }

  const raw = flat[path];
  return (
    <div className="space-y-1">
      <FieldLabel field={field} htmlFor={id} />
      <input
        {...common}
        type={inputType(field.kind)}
        {...(field.kind === "number" ? { step: "any" } : {})}
        value={typeof raw === "string" ? raw : ""}
        onChange={(e) => onChange(path, e.target.value)}
        className={inputClass}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function ResultView({
  result,
  collecting,
  onCollect,
}: {
  result: CommuneResult;
  collecting: boolean;
  onCollect: () => void;
}) {
  switch (result.kind) {
    case "ok":
      return (
        <div className="space-y-2">
          <p className="text-sm text-spectral">The spirit answered.</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-text">
            {formatJson(result.data)}
          </pre>
        </div>
      );
    case "ghost":
      return (
        <div className="space-y-2">
          <p className="rounded-md border border-spectral/60 px-3 py-2 text-sm text-spectral">
            Ghost mode: nothing was sent
          </p>
          <p className="text-sm text-muted">This is a made-up result. The real service was not called.</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-text">
            {formatJson(result.data)}
          </pre>
        </div>
      );
    case "held":
      return (
        <div className="space-y-2">
          <p className="text-sm text-text">
            This call is held for a human to release. Nothing has been sent yet.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a href="#inbox" className="text-sm text-candle underline">
              Open the Inbox
            </a>
            <button
              type="button"
              disabled={collecting}
              onClick={onCollect}
              className="rounded-md border border-candle/60 px-3 py-1 text-sm text-candle disabled:opacity-50"
            >
              Collect result
            </button>
          </div>
        </div>
      );
    case "blocked":
      return (
        <p role="alert" className="text-sm text-vengeful">
          Blocked: {result.message}
        </p>
      );
    case "fault":
      return (
        <p role="alert" className="text-sm text-vengeful">
          The call did not go through. {result.message}
        </p>
      );
    case "rate_limited":
      return (
        <p role="alert" className="text-sm text-vengeful">
          {COMMUNE_MESSAGES.rate_limited}
        </p>
      );
    case "unavailable":
      return (
        <p role="alert" className="text-sm text-vengeful">
          {COMMUNE_MESSAGES.unavailable}
        </p>
      );
  }
}

/** Try one operation from the browser. Goes through the same MCP endpoint, and the same safety rules, as an agent. */
export function CommuneForm({ serviceId, toolName, inputDescriptor, fetchImpl }: CommuneFormProps) {
  const idBase = useId();
  const model = toFormModel(inputDescriptor);
  const [flat, setFlat] = useState<FlatValues>({});
  const [errors, setErrors] = useState<Errors>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<CommuneResult | null>(null);
  const [notice, setNotice] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const run = async (
    next: Phase,
    start: (signal: AbortSignal) => Promise<CommuneResult>,
  ): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase(next);
    setNotice("");
    try {
      const outcome = await start(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setResult(outcome);
      setPhase("idle");
    } catch {
      if (!mountedRef.current || controller.signal.aborted) return;
      setResult({ kind: "unavailable" });
      setPhase("idle");
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (phase !== "idle") return;
    const validation = validateCommune(inputDescriptor, flat);
    if (!validation.ok) {
      setErrors(validation.errors);
      setResult(null);
      return;
    }
    setErrors({});
    setResult(null);
    void run("waiting", (signal) =>
      callTool(serviceId, toolName, validation.args, { signal, fetch: fetchImpl }),
    );
  };

  const stopWaiting = (): void => {
    controllerRef.current?.abort();
    setPhase("idle");
    setNotice("Stopped waiting. If the call was held, it is still in the Inbox.");
  };

  const collect = (approvalId: string): void => {
    void run("collecting", (signal) => collectResult(serviceId, approvalId, { signal, fetch: fetchImpl }));
  };

  const onChange = (path: string, value: string | boolean): void => {
    setFlat((prev) => ({ ...prev, [path]: value }));
    setErrors((prev) => {
      if (!(path in prev)) return prev;
      const { [path]: _removed, ...rest } = prev;
      void _removed;
      return rest;
    });
  };

  const summaryErrors = Object.entries(errors);
  const busy = phase !== "idle";
  const heldResult = result !== null && result.kind === "held" ? result : null;

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-3" aria-label={`Commune with ${toolName}`}>
      {model.length === 0 ? (
        <p className="text-sm text-muted">This operation takes no arguments.</p>
      ) : (
        model.map((field) => (
          <FieldView
            key={field.name}
            field={field}
            path={field.name}
            idBase={idBase}
            flat={flat}
            errors={errors}
            disabled={busy}
            onChange={onChange}
          />
        ))
      )}

      {summaryErrors.length > 0 ? (
        <div role="alert" className="text-sm text-vengeful">
          <p>Fix {summaryErrors.length === 1 ? "this field" : "these fields"} before sending:</p>
          <ul className="list-disc pl-5">
            {summaryErrors.map(([path, message]) => (
              <li key={path} className="break-words">
                {path === ROOT_KEY ? message : `${path}: ${message}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-candle/60 px-3 py-1 text-sm text-candle disabled:opacity-50"
        >
          Commune
        </button>
        {phase === "waiting" ? (
          <button
            type="button"
            onClick={stopWaiting}
            className="rounded-md border border-border px-3 py-1 text-sm text-text"
          >
            Stop waiting
          </button>
        ) : null}
      </div>

      <div aria-live="polite" className="space-y-2">
        {phase === "waiting" ? (
          <p className="text-sm text-muted">Waiting for a human to release this call</p>
        ) : null}
        {phase === "collecting" ? <p className="text-sm text-muted">Collecting the result…</p> : null}
        {notice !== "" ? <p className="text-sm text-muted">{notice}</p> : null}
      </div>

      {result !== null ? (
        <ResultView
          result={result}
          collecting={busy}
          onCollect={() => {
            if (heldResult) collect(heldResult.approvalId);
          }}
        />
      ) : null}
    </form>
  );
}
