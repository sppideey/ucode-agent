# What this project already has

It was created by ucode's `create_app` from a starter that is known to build.
Do not re-run create-next-app or `shadcn init` — everything below is in place.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- shadcn/ui on Radix (the standard shadcn you know — `asChild` works), lucide-react icons
- next-themes (light / dark / system), sonner toasts, date-fns, react-day-picker

Next 16 changed some APIs. `AGENTS.md` explains, and `node_modules/next/dist/docs/`
has the guides — check them before using an API you are unsure of.

## Already wired

- `src/app/layout.tsx` — font (Geist, registered as `--font-sans`), `ThemeProvider`,
  `TooltipProvider`, and `<Toaster />`.
- `src/components/theme-toggle.tsx` — a light/dark button, ready to place.
- `src/app/globals.css` — the design tokens. The palette is a starting point:
  re-tint `--primary`, `--accent` and the neutrals for this app's direction.
  `--success` and `--warning` exist alongside `--destructive`
  (`bg-success`, `text-warning`, ...).
- `src/app/page.tsx` — a placeholder. Replace it.

`layout.tsx`, `theme-provider.tsx`, `theme-toggle.tsx`, `src/lib/utils.ts` and
everything in `src/components/ui/` are finished and build. Use them; do not
rewrite them — a rewrite from memory brings back APIs that no longer exist.

## Components in `src/components/ui/`

accordion, alert-dialog, avatar, badge, button, calendar, card, checkbox, collapsible, command, dialog, dropdown-menu, hover-card, input-group, input, label, popover, progress, radio-group, scroll-area, select, separator, sheet, skeleton, slider, sonner, switch, table, tabs, textarea, toggle-group, toggle, tooltip

Anything else: `npx shadcn@latest add <name> -y` with cwd set to this folder.

## APIs that are easy to get wrong

```tsx
// Toasts — sonner. A message first, options second. There is no toast({ title }).
import { toast } from "sonner";
toast.success("Saved");
toast("Task deleted", { description: "Buy milk", action: { label: "Undo", onClick: () => restore() } });

// Slider — value is an ARRAY, even for one thumb.
<Slider value={[tip]} onValueChange={([v]) => setTip(v)} min={0} max={30} step={1} />

// Select — value is a string.
<Select value={list} onValueChange={(v: string) => setList(v)}>
  <SelectTrigger><SelectValue placeholder="Pick a list" /></SelectTrigger>
  <SelectContent><SelectItem value="inbox">Inbox</SelectItem></SelectContent>
</Select>

// Date picker — Calendar inside a Popover.
<Popover>
  <PopoverTrigger asChild><Button variant="outline">{date ? format(date, "PPP") : "Pick a date"}</Button></PopoverTrigger>
  <PopoverContent className="w-auto p-0"><Calendar mode="single" selected={date} onSelect={setDate} /></PopoverContent>
</Popover>

// Toggle group — value is a string for type="single".
<ToggleGroup type="single" value={preset} onValueChange={(v) => v && setPreset(v)}>
  <ToggleGroupItem value="15">15%</ToggleGroupItem>
</ToggleGroup>

// Anything using useState, events, localStorage or browser APIs needs "use client"
// as the first line of its file.

// localStorage — read it in useEffect, never in render or a useState initializer:
// the page is also rendered on the server, where localStorage does not exist.
const [bill, setBill] = useState("");
useEffect(() => { setBill(localStorage.getItem("bill") ?? ""); }, []);
useEffect(() => { localStorage.setItem("bill", bill); }, [bill]);

// next-themes — there is no "next-themes/dist/types". Import from "next-themes".
```

## Where a file goes

Routing is folder-based and it is **not** flexible: a page is only a route if
it sits at `src/app/<segment>/page.tsx`. A `page.tsx` anywhere else is an
ordinary file that nothing ever renders.

```
src/
  app/
    layout.tsx            the shell, already written
    page.tsx              /
    globals.css           the design tokens — re-tint these
    expenses/page.tsx     /expenses
    api/expenses/route.ts GET/POST /api/expenses
  components/
    expenses/list.tsx     feature components, one per file
    ui/                   the 33 shadcn primitives, already here
  lib/
    store.ts              data, schemas, anything the server owns
```

Wrong, and it silently does nothing: `expenses/page.tsx` at the project root,
or `components/` beside `src/` instead of inside it. The app builds, the
route 404s, and nothing tells you why.

## Conventions

- Components are named exports — `export function BillInput()` — imported with
  braces: `import { BillInput } from "@/components/calculator/bill-input"`.
  Only `page.tsx` and `layout.tsx` use `export default`.
- One component per file, grouped by feature: `src/components/<feature>/`.
- Shared types in `src/lib/types.ts`, helpers in `src/lib/`.
- `cn()` from `@/lib/utils` to merge class names.
