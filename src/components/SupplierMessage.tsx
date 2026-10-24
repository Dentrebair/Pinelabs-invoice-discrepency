"use client";

import { useEffect, useRef, useState } from "react";

export function SupplierMessage({ message }: { message: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(message);
      ok = true;
    } catch {
      // Fallback for non-secure contexts / denied permission.
      const ta = document.createElement("textarea");
      ta.value = message;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <div>
      <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-sans text-sm leading-relaxed text-slate-800 ring-1 ring-slate-200">{message}</pre>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copy}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        >
          {state === "copied" ? "Copied ✓" : "Copy message"}
        </button>
        <span role="status" className={`text-sm ${state === "failed" ? "text-red-700" : "text-slate-500"}`}>
          {state === "failed" ? "Copy failed — select the text and copy it manually." : "Draft only — nothing is sent to the supplier from here."}
        </span>
      </div>
    </div>
  );
}
