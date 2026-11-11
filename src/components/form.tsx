"use client";

import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { FormAction, FormState } from "@/lib/form-state";

const FormContext = createContext<{ state: FormState; pending: boolean }>({
  state: {},
  pending: false,
});

const INPUT =
  "mt-1.5 block min-h-12 w-full rounded-xl border border-line bg-card px-3.5 py-2.5 text-base text-ink placeholder:text-muted/50 transition-all duration-150 focus:border-gold focus:ring-2 focus:ring-gold/20 aria-invalid:border-danger aria-invalid:bg-danger-wash/20";

/**
 * Submits through a transition rather than the form's action prop, because
 * React clears the form after an action and people would lose what they typed
 * whenever validation failed.
 */
export function ActionForm({
  action,
  children,
  className = "space-y-4",
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };

  return (
    <form ref={ref} onSubmit={onSubmit} className={className} noValidate>
      <FormContext.Provider value={{ state, pending }}>
        {state.error ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl border border-danger-border bg-danger-wash px-4 py-3 text-sm font-semibold text-danger shadow-sm"
          >
            <AlertCircle size={18} className="shrink-0" />
            <span>{state.error}</span>
          </div>
        ) : null}
        {state.message ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl border border-ok-border bg-ok-wash px-4 py-3 text-sm font-semibold text-ok shadow-sm"
          >
            <CheckCircle2 size={18} className="shrink-0" />
            <span>{state.message}</span>
          </div>
        ) : null}
        {children}
      </FormContext.Provider>
    </form>
  );
}

/** The error for a field that does not use Field, such as a radio group. */
export function FieldError({ name }: { name: string }) {
  const error = useContext(FormContext).state.fieldErrors?.[name];
  return error ? (
    <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-danger">
      <AlertCircle size={14} className="shrink-0" />
      <span>{error}</span>
    </p>
  ) : null;
}

function Wrapper({
  name,
  label,
  hint,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const error = useContext(FormContext).state.fieldErrors?.[name];
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-bold text-ink">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-xs font-medium text-muted">{hint}</p> : null}
      {error ? (
        <p id={`${name}-error`} className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-danger">
          <AlertCircle size={14} className="shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

type FieldProps = { name: string; label: string; hint?: string };

const errorProps = (name: string, error?: string) =>
  error ? { "aria-invalid": true, "aria-describedby": `${name}-error` } : {};

export function Field({ name, label, hint, ...rest }: FieldProps & ComponentProps<"input">) {
  const error = useContext(FormContext).state.fieldErrors?.[name];
  return (
    <Wrapper name={name} label={label} hint={hint}>
      <input id={name} name={name} className={INPUT} {...errorProps(name, error)} {...rest} />
    </Wrapper>
  );
}

export function SelectField({
  name,
  label,
  hint,
  children,
  ...rest
}: FieldProps & ComponentProps<"select">) {
  const error = useContext(FormContext).state.fieldErrors?.[name];
  return (
    <Wrapper name={name} label={label} hint={hint}>
      <select id={name} name={name} className={`${INPUT} cursor-pointer`} {...errorProps(name, error)} {...rest}>
        {children}
      </select>
    </Wrapper>
  );
}

export function TextareaField({ name, label, hint, ...rest }: FieldProps & ComponentProps<"textarea">) {
  const error = useContext(FormContext).state.fieldErrors?.[name];
  return (
    <Wrapper name={name} label={label} hint={hint}>
      <textarea id={name} name={name} rows={2} className={INPUT} {...errorProps(name, error)} {...rest} />
    </Wrapper>
  );
}

export function SubmitButton({
  children,
  tone = "primary",
  className = "",
}: {
  children: ReactNode;
  tone?: "primary" | "plain";
  className?: string;
}) {
  const { pending } = useContext(FormContext);
  const style =
    tone === "primary"
      ? "bg-gradient-to-r from-gold to-gold-light text-ink font-bold shadow-gold-sm hover:brightness-105 border border-gold-deep/20"
      : "border border-line-strong bg-card text-ink hover:bg-gold-wash";

  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-bold tracking-wide transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto ${style} ${className}`}
    >
      {pending ? (
        <>
          <Loader2 size={18} className="animate-spin text-ink" />
          <span>Saving…</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
