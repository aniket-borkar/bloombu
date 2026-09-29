import { useState } from "react";
import { api, useData } from "../api";
import { Grid } from "../components/Grid";
import { fmtIsoDate, fmtNum } from "../terminal/format";
import { DataState, Section, type ScreenProps } from "./common";

export function formatFieldValue(v: number | string | null | undefined, type: string): string {
  if (v === null || v === undefined) return "";
  if (type === "date") return fmtIsoDate(String(v));
  if (typeof v === "number") return Math.abs(v) >= 1e6 ? fmtNum(v, 0) : fmtNum(v, Math.abs(v) < 1 ? 4 : 2);
  return String(v);
}

/** FLDS: field dictionary, with values for the loaded security. */
export function FldsScreen({ security }: ScreenProps) {
  const list = useData("field-list", (s) => api.fieldList(s), 3_600_000);
  const ids = list.data?.map((f) => f.id) ?? [];
  const values = useData(security && ids.length ? `flds|${security}` : null, (s) => api.fields([security!], ids, s), 60_000);
  const [filter, setFilter] = useState("");
  if (!list.data) return <DataState state={list} what="FIELD LIST" />;
  const q = filter.trim().toUpperCase();
  const rows = list.data.filter((f) => !q || f.id.includes(q) || f.description.toUpperCase().includes(q) || f.category.toUpperCase().includes(q));
  const v = security ? values.data?.[security] : undefined;
  return (
    <div className="col-flex" data-testid="flds-screen">
      <div className="toolbar">
        <label className="label">
          Search <input className="form-input" value={filter} data-testid="flds-search" onChange={(e) => setFilter(e.target.value)} />
        </label>
        <span className="gray">
          {rows.length} fields · use in SHEET as =BDP("AAPL US Equity","PE_RATIO") or in BQL{security ? ` · values for ${security}` : ""}
        </span>
      </div>
      <Section title="Field Dictionary" />
      <Grid
        readOnly
        testId="flds-grid"
        columns={[
          { key: "id", label: "Field" },
          { key: "d", label: "Description" },
          { key: "c", label: "Category" },
          { key: "v", label: security ? "Value" : "", align: "right" },
        ]}
        rows={rows.map((f) => [f.id, f.description, f.category, v ? formatFieldValue(v[f.id], f.type) : ""])}
      />
    </div>
  );
}
