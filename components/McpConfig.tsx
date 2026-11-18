"use client";

import { useEffect, useRef, useState } from "react";

const ANNOUNCE_MS = 2000;

type Block = { id: string; label: string; value: string; multiline: boolean };

/** Copies text with the Clipboard API, falling back to a hidden textarea. Returns success. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
  );
}

export function McpConfig({
  mcpUrl,
  clientConfigJson,
  cliCommand,
}: {
  mcpUrl: string;
  clientConfigJson: string;
  cliCommand: string;
}) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy(block: Block) {
    const ok = await copyText(block.value);
    setMessage(ok ? "Copied" : "Copy failed. Select the text and copy it manually.");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), ANNOUNCE_MS);
  }

  const blocks: Block[] = [
    { id: "url", label: "MCP URL", value: mcpUrl, multiline: false },
    { id: "json", label: "Client config (JSON)", value: clientConfigJson, multiline: true },
    { id: "cli", label: "Claude Code command", value: cliCommand, multiline: false },
  ];

  return (
    <div className="space-y-4">
      {blocks.map((block) => (
        <div key={block.id} className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p id={`mcp-${block.id}-label`} className="text-sm font-medium text-text">
              {block.label}
            </p>
            <button
              type="button"
              onClick={() => void copy(block)}
              aria-label={`Copy ${block.label}`}
              className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-border bg-surface-raised px-3 text-sm text-text hover:border-candle"
            >
              <CopyIcon />
              <span>Copy</span>
            </button>
          </div>
          <pre
            tabIndex={0}
            aria-labelledby={`mcp-${block.id}-label`}
            className="max-w-full overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-sm text-text"
          >
            <code className={block.multiline ? "whitespace-pre" : "whitespace-pre-wrap [overflow-wrap:anywhere]"}>
              {block.value}
            </code>
          </pre>
        </div>
      ))}
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-spectral">
        {message}
      </p>
    </div>
  );
}
