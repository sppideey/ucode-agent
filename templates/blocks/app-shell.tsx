"use client";

import { ReactNode, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type NavItem = { href: string; label: string; icon?: ReactNode };

/**
 * The frame every page sits in: a sidebar on a wide screen, the same nav
 * behind a button on a phone. One list of links drives both, so they cannot
 * drift apart.
 */
export function AppShell({
  nav,
  current,
  title,
  children,
}: {
  nav: NavItem[];
  current?: string;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const links = (onNavigate?: () => void) => (
    <nav className="space-y-1" aria-label="Main">
      {nav.map((item) => {
        const active = current === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "flex items-center gap-3 rounded-md bg-muted px-3 py-2 text-sm font-medium"
                : "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            }
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-60 shrink-0 border-r p-4 md:block">
        <div className="mb-6 px-3 text-sm font-semibold tracking-tight">{title}</div>
        {links()}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b px-4 md:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="md:hidden" aria-label="Open menu">
                Menu
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-4">
              <SheetTitle className="mb-6 px-3 text-sm font-semibold">{title}</SheetTitle>
              {links(() => setOpen(false))}
            </SheetContent>
          </Sheet>
          <span className="text-sm font-medium md:hidden">{title}</span>
        </header>

        <main className="min-w-0 flex-1 p-4 md:p-8">
          <div className="mx-auto w-full max-w-6xl space-y-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
