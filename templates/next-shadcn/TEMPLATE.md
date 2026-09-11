# What this project already has

It was created by ucode's `create_app` from a starter that is known to build.
Do not re-run create-next-app or `shadcn init` — everything below is in place.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- shadcn/ui ("base-nova" style, built on `@base-ui/react`), lucide-react icons
- next-themes (light / dark / system), sonner toasts, date-fns

Next 16 changed APIs. `AGENTS.md` explains, and `node_modules/next/dist/docs/`
has the guides — check them before using an API you are unsure of.

## Already wired

- `src/app/layout.tsx` — font (Geist, registered as `--font-sans`), `ThemeProvider`,
  `TooltipProvider`, and `<Toaster />`. Call `toast()` from `sonner` anywhere.
- `src/components/theme-toggle.tsx` — a light/dark button, ready to place.
- `src/app/globals.css` — the design tokens. The palette is a starting point:
  re-tint `--primary`, `--accent` and the neutrals for this app's direction.
  `--success` and `--warning` exist alongside `--destructive`
  (`bg-success`, `text-warning`, ...).
- `src/app/page.tsx` — a placeholder. Replace it.

## Components in `src/components/ui/`

alert-dialog, avatar, badge, button, calendar, card, checkbox, command, dialog,
dropdown-menu, input, input-group, label, popover, progress, scroll-area, select,
separator, sheet, skeleton, sonner, switch, tabs, textarea, tooltip

Anything else: `npx shadcn@latest add <name> -y`.

## Conventions

- One component per file, grouped by feature: `src/components/<feature>/`.
- Shared types in `src/lib/types.ts`, helpers in `src/lib/`.
- `"use client"` only on components that need state or events.
- `cn()` from `@/lib/utils` to merge class names.
