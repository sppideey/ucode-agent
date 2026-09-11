import { ThemeToggle } from "@/components/theme-toggle";

// Placeholder — replace this whole page with the app.
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="space-y-3 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">__APP_NAME__</h1>
        <p className="text-muted-foreground">Replace src/app/page.tsx with the app.</p>
        <ThemeToggle />
      </div>
    </main>
  );
}
