import { redirect } from "next/navigation";
import { isStaff } from "@/lib/permissions";
import { getActor } from "@/lib/session";

export default async function Home() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  redirect(isStaff(actor.role) ? "/dashboard" : "/me");
}
