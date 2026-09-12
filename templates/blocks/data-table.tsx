"use client";

import { useMemo, useState, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export type Column<T> = {
  key: keyof T & string;
  header: string;
  /** Right-align and tabular-nums, for money and counts. */
  numeric?: boolean;
  render?: (row: T) => ReactNode;
};

/**
 * A table of things you can search and sort.
 *
 * Sorting and filtering happen here, over rows already in memory: it is the
 * right shape up to a few thousand rows and the wrong one past that, where
 * the server should be doing both.
 */
export function DataTable<T extends { id: string | number }>({
  rows,
  columns,
  searchPlaceholder = "Search…",
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  searchPlaceholder?: string;
  empty?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; asc: boolean } | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let out = needle
      ? rows.filter((row) =>
          columns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(needle)))
      : rows.slice();
    if (sort) {
      out.sort((a, b) => {
        const x = a[sort.key as keyof T];
        const y = b[sort.key as keyof T];
        if (typeof x === "number" && typeof y === "number") return sort.asc ? x - y : y - x;
        return sort.asc
          ? String(x ?? "").localeCompare(String(y ?? ""))
          : String(y ?? "").localeCompare(String(x ?? ""));
      });
    }
    return out;
  }, [rows, columns, query, sort]);

  const toggle = (key: string) =>
    setSort((s) => (s?.key === key ? { key, asc: !s.asc } : { key, asc: true }));

  return (
    <div className="space-y-4">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={searchPlaceholder}
        className="max-w-xs"
        aria-label={searchPlaceholder}
      />

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.key} className={c.numeric ? "text-right" : undefined}>
                  <button
                    type="button"
                    onClick={() => toggle(c.key)}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    aria-label={`Sort by ${c.header}`}
                  >
                    {c.header}
                    <span aria-hidden className="text-xs text-muted-foreground">
                      {sort?.key === c.key ? (sort.asc ? "↑" : "↓") : ""}
                    </span>
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-28 text-center text-sm text-muted-foreground">
                  {query ? `Nothing matches “${query}”.` : empty ?? "Nothing here yet."}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className={c.numeric ? "text-right tabular-nums" : undefined}
                    >
                      {c.render ? c.render(row) : String(row[c.key] ?? "")}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
