"use client";

import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSearchVisitorProfiles } from "@/features/visitors/hooks/use-visitors";

export interface PickedVisitor {
  id: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
}

interface VisitorProfilePickerProps {
  id: string;
  value: PickedVisitor | null;
  onChange: (visitor: PickedVisitor | null) => void;
  invalid?: boolean;
  describedBy?: string;
}

// The search endpoint returns backend profiles, whose email field is
// ``emailAddress`` on the wire rather than the ``email`` the shared type names.
type SearchRow = { id: string; fullName?: string; phone?: string; email?: string; emailAddress?: string };

/** Search the tenant's visitor profiles by name, phone or email and pick one. */
export function VisitorProfilePicker({ id, value, onChange, invalid, describedBy }: VisitorProfilePickerProps) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const search = useSearchVisitorProfiles(query);
  const rows = (search.data ?? []) as unknown as SearchRow[];

  if (value) {
    return (
      <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{value.fullName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {[value.phone, value.email].filter(Boolean).join(" · ") || "No contact on file"}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} aria-label="Choose a different visitor">
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search visitors by name, phone or email"
          className="min-h-[44px] pl-9"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          autoComplete="off"
        />
        {search.isFetching && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      {query.length >= 2 && !search.isFetching && (
        <ul role="listbox" aria-label="Matching visitors" className="max-h-64 overflow-y-auto rounded-md border">
          {rows.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No visitors match "{query}"</li>}
          {rows.map((r) => {
            const email = r.emailAddress ?? r.email;
            return (
              <li key={r.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none"
                  onClick={() => onChange({ id: r.id, fullName: r.fullName || "Unnamed visitor", phone: r.phone, email })}
                >
                  <span className="block truncate text-sm font-medium">{r.fullName || "Unnamed visitor"}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[r.phone, email].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
