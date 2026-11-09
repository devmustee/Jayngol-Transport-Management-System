import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { loginAction } from "@/app/actions";
import { ClearOffline } from "@/components/clear-offline";
import { ActionForm, Field, SubmitButton } from "@/components/form";
import { getActor } from "@/lib/session";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage() {
  if (await getActor()) redirect("/");
  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-gradient-to-br from-[#0c0a07] via-ink to-[#1a150c] p-4 text-paper overflow-hidden">
      <ClearOffline />

      {/* Ambient background glows */}
      <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-gold/15 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-gold-deep/25 blur-[120px]" />

      <div className="relative z-10 w-full max-w-md rounded-3xl border border-gold-deep/30 bg-card p-7 sm:p-9 shadow-2xl text-ink">
        <div className="text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/jayngol-mark.svg"
            alt="Jayngol Logo"
            width={84}
            height={84}
            className="mx-auto drop-shadow-md"
          />
          <h1 className="mt-4 text-2xl font-black tracking-tight text-ink">
            Jayngol Transport
          </h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            Fleet Operations & Cashier Portal
          </p>
        </div>

        <div className="mt-7">
          <ActionForm action={loginAction} className="space-y-4">
            <Field
              name="phone"
              label="Phone number"
              type="tel"
              placeholder="e.g. 08012345678"
              autoComplete="username"
            />
            <Field
              name="secret"
              label="Password or Operator PIN"
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
            />
            <div className="pt-2 [&>button]:w-full">
              <SubmitButton>Sign in to Workspace</SubmitButton>
            </div>
          </ActionForm>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 border-t border-line/60 pt-4 text-xs font-semibold text-muted">
          <ShieldCheck size={16} className="text-ok" />
          <span>Encrypted Session • Authorised Access Only</span>
        </div>
      </div>
    </main>
  );
}
