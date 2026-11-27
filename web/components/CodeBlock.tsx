"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A code sample with a copy control that reports what actually happened. `navigator.clipboard` is unavailable on
 * insecure origins and in some embeds, so a failed copy says so rather than claiming success and leaving the reader
 * with nothing on their clipboard.
 */
export function CodeBlock({ code, title }: { code: string; title: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // the label resets on its own, so clear a pending reset if the reader copies again or the panel goes away
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2200);
  }

  return (
    <div className="code">
      <div className="code-h">
        <span>{title}</span>
        <button className="btn quiet sm copy" onClick={copy}>
          {state === "copied" ? "Copied" : state === "failed" ? "Select it manually" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0} aria-label={`Code sample: ${title}`}>
        <code>{code}</code>
      </pre>
      <p className="sr" role="status">
        {state === "copied" ? "The sample is on your clipboard." : state === "failed" ? "Copying was blocked by the browser. Select the text and copy it yourself." : ""}
      </p>
    </div>
  );
}
