"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

const key = (pathname: string) => `place:${pathname}`;

/**
 * Remembers the last address of each page in this tab, filters and search
 * included, so a back link to a list returns to the list as it was left.
 */
export function PlaceMemory() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    try {
      sessionStorage.setItem(key(pathname), search ? `${pathname}?${search}` : pathname);
    } catch {
      // Storage can be blocked; back links then use their plain address.
    }
  }, [pathname, search]);
  return null;
}

/** A back link that returns to the page as it was left, when it was visited in this tab. */
export function BackLink({ href, label }: { href: string; label: string }) {
  const [target, setTarget] = useState(href);
  useEffect(() => {
    if (href.includes("?") || href.includes("#")) return;
    try {
      const remembered = sessionStorage.getItem(key(href));
      if (remembered && remembered.startsWith(`${href}?`)) setTarget(remembered);
    } catch {
      // Keep the plain address.
    }
  }, [href]);
  return (
    <Link
      href={target}
      className="group inline-flex min-h-11 items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold text-gold-deep transition-all duration-150 hover:bg-gold-wash"
    >
      <ArrowLeft size={16} className="transition-transform group-hover:-translate-x-0.5" />
      <span>{label}</span>
    </Link>
  );
}
