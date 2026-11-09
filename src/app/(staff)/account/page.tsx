import type { Metadata } from "next";
import Link from "next/link";
import { changePasswordAction, logoutAction } from "@/app/actions";
import { ActionForm, Field, SubmitButton } from "@/components/form";
import { Card, PageHeader } from "@/components/ui";
import { can, ROLE_LABELS } from "@/lib/permissions";
import { requireStaffCtx } from "@/lib/session";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const { actor } = await requireStaffCtx();
  const links = [
    ...(can(actor.role, "inspection.record") ? [{ href: "/inspections", label: "Inspect tricycles" }] : []),
    ...(can(actor.role, "workorder.view") ? [{ href: "/workshop", label: "Workshop" }] : []),
    ...(can(actor.role, "workorder.view") ? [{ href: "/workshop/history", label: "Service and repair history" }] : []),
    ...(can(actor.role, "stock.view") ? [{ href: "/store", label: "Store" }] : []),
    ...(can(actor.role, "stock.view") ? [{ href: "/store/usage", label: "Store usage record" }] : []),
    ...(can(actor.role, "violation.view") ? [{ href: "/offences", label: "Offences" }] : []),
    ...(can(actor.role, "meeting.view") ? [{ href: "/meetings", label: "Meetings" }] : []),
    ...(can(actor.role, "inspection.report") ? [{ href: "/inspections/report", label: "Inspection report" }] : []),
    ...(can(actor.role, "violation.view") ? [{ href: "/rules", label: "Rules and fines" }] : []),
    ...(can(actor.role, "finance.view") ? [{ href: "/transfers", label: "Move money" }, { href: "/bank", label: "Bank check" }] : []),
    ...(can(actor.role, "finance.view") ? [{ href: "/reports", label: "Reports" }, { href: "/awards", label: "Awards" }] : []),
    ...(can(actor.role, "user.manage") ? [{ href: "/users", label: "Staff logins" }] : []),
    ...(can(actor.role, "audit.view") ? [{ href: "/audit", label: "Audit log" }] : []),
  ];
  return (
    <>
      <PageHeader title={actor.name} subtitle={ROLE_LABELS[actor.role]} />
      <div className="space-y-4">
        {links.length > 0 ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card md:hidden">
            {links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="flex min-h-12 items-center justify-between px-4 font-semibold">
                  {link.label} <span aria-hidden className="text-gold-deep">→</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <Card title="Change password">
          <ActionForm action={changePasswordAction}>
            <Field name="currentPassword" label="Current password" type="password" autoComplete="current-password" />
            <Field name="password" label="New password" type="password" autoComplete="new-password" hint="At least 8 characters." />
            <SubmitButton>Change password</SubmitButton>
          </ActionForm>
        </Card>
        <form action={logoutAction}>
          <button className="min-h-11 w-full rounded-lg border border-line bg-card px-4 font-semibold hover:bg-gold-wash">
            Log out
          </button>
        </form>
      </div>
    </>
  );
}
