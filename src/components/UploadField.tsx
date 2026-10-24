"use client";

import { useEffect, useId, useRef, useState } from "react";
import { validatePdf } from "@/lib/ui/api-client";

export function UploadField({
  label,
  hint,
  file,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const error = validatePdf(file);

  // Clearing state (e.g. after a successful run) must also clear the input, or re-picking the same file is ignored.
  useEffect(() => {
    if (file === null && input.current) input.current.value = "";
  }, [file]);

  function pick(f: File | null | undefined) {
    onChange(f ?? null);
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-800">
        {label}
      </label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) pick(e.dataTransfer.files[0]);
        }}
        className={`flex items-center gap-3 rounded-lg border border-dashed px-3 py-3 transition-colors ${
          error ? "border-red-400 bg-red-50" : over ? "border-indigo-500 bg-indigo-50" : file ? "border-emerald-400 bg-emerald-50/50" : "border-slate-300 bg-white"
        } ${disabled ? "opacity-60" : ""}`}
      >
        <input
          ref={input}
          id={id}
          type="file"
          accept="application/pdf,.pdf"
          disabled={disabled}
          className="sr-only"
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => input.current?.click()}
          className="shrink-0 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed"
        >
          {file ? "Replace" : "Choose PDF"}
        </button>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-600" title={file?.name}>
          {file ? file.name : (hint ?? "or drop a PDF here")}
        </span>
        {file && !disabled && (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={() => {
              if (input.current) input.current.value = "";
              pick(null);
            }}
            className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-600"
          >
            ✕
          </button>
        )}
      </div>
      {error && (
        <p id={`${id}-err`} role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
