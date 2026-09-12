import { Card, CardContent } from "@/components/ui/card";

export type Stat = {
  label: string;
  value: string;
  /** Change since the last period, e.g. 12 or -3.4. Omit for no delta. */
  change?: number;
  hint?: string;
};

/**
 * The row of numbers at the top of a dashboard.
 *
 * A number on its own says nothing, so each one carries what it is measured
 * against. Rising is not always good, so the colour follows the sign and the
 * caller words the label.
 */
export function StatCards({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardContent className="space-y-2 p-5">
            <p className="text-sm font-medium text-muted-foreground">{stat.label}</p>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums tracking-tight">{stat.value}</span>
              {stat.change !== undefined ? (
                <span
                  className={
                    stat.change >= 0
                      ? "text-xs font-medium text-emerald-600 dark:text-emerald-400"
                      : "text-xs font-medium text-rose-600 dark:text-rose-400"
                  }
                >
                  {stat.change >= 0 ? "+" : ""}
                  {stat.change}%
                </span>
              ) : null}
            </div>
            {stat.hint ? <p className="text-xs text-muted-foreground">{stat.hint}</p> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
