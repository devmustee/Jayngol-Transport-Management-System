"use client";

import { useEffect, useRef, useState } from "react";
import { compressPhoto } from "@/lib/compress-photo";
import { FieldError } from "./form";

/** Compresses on the phone and submits the result in a hidden field. */
export function PhotoInput({ name, label }: { name: string; label: string }) {
  const [photo, setPhoto] = useState("");
  const [problem, setProblem] = useState("");
  const hidden = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const form = hidden.current?.form;
    const clear = () => setPhoto("");
    form?.addEventListener("reset", clear);
    return () => form?.removeEventListener("reset", clear);
  }, []);

  return (
    <div>
      <label className="block font-medium">
        {label}
        <input
          type="file"
          accept="image/*"
          className="mt-1 block w-full rounded-lg border border-line bg-card p-2 text-base"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setProblem("");
            try {
              setPhoto(await compressPhoto(file));
            } catch {
              setPhoto("");
              setProblem("That image could not be read. Try another one.");
            }
          }}
        />
      </label>
      <input ref={hidden} type="hidden" name={name} value={photo} />
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="Selected" className="mt-2 max-h-40 rounded-lg" />
      ) : null}
      {problem ? <p className="mt-1 text-sm font-medium text-danger">{problem}</p> : null}
      <FieldError name={name} />
    </div>
  );
}
