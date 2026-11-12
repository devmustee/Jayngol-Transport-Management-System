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
    <main className="flex min-h-dvh items-center justify-center bg-paper p-4">
      <ClearOffline />


      <div className="w-full max-w-sm rounded-2xl border border-line bg-card p-6 text-ink sm:p-8">
        <div className="text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/jayngol-mark.svg"
            alt="Jayngol Logo"
            width={56}
            height={56}
            className="mx-auto"
          />
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-ink">Sign in to Jayngol</h1>
          <p className="mt-1 text-sm text-muted">Staff and operators</p>
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
              <SubmitButton>Sign in</SubmitButton>
            </div>
          </ActionForm>
        </div>

        <div className="mt-6 flex items-center justify-center gap-1.5 border-t border-line/60 pt-4 text-xs text-muted">
          <ShieldCheck size={16} className="text-ok" />
          <span>Secure sign-in for authorised people only</span>
        </div>
      </div>
    </main>
  );
}
