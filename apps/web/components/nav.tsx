"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/reorgs", label: "Reorgs" },
  { href: "/quality", label: "Quality" },
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/explorer", label: "Explorer" },
  { href: "/analytics", label: "Analytics" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex flex-wrap gap-x-1 gap-y-1">
        {LINKS.map((l) => {
          const current = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={current ? "page" : undefined}
                className={`block rounded px-3 py-1.5 text-sm font-medium ${current ? "bg-blue-900 text-white" : "text-blue-900 hover:bg-blue-50"}`}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
