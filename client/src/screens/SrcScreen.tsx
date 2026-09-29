import type { SourcesReport } from "../../../server/src/types";
import { api, useData } from "../api";
import { fmtNum } from "../terminal/format";
import { DataState, DataTable, KeyValues, Section, type ScreenProps } from "./common";

const limitText = (u: SourcesReport["providers"][number]["usage"]) =>
  u.limit ? [u.limit.perMinute !== undefined && `${u.limit.perMinute}/min`, u.limit.perDay !== undefined && `${u.limit.perDay}/day`].filter(Boolean).join(", ") : "none";

/** SRC: every data source, how hard it is being used against its free tier, and the free upgrades still available. */
export function SrcScreen({ panel }: ScreenProps) {
  const state = useData("sources", (s) => api.sources(s), 15_000);
  const d = state.data;
  if (!d) return <DataState state={state} what="SOURCES" />;
  return (
    <div className="col-flex" data-testid="src-screen">
      <Section title="Data Sources" right="Everything here is free: self-hosted, no data resale, your own free keys" />
      <DataTable
        panel={panel}
        paged={false}
        testId="src-providers"
        rows={d.providers}
        columns={[
          { key: "id", label: "Source", render: (p) => <span className="white">{p.id}</span> },
          { key: "note", label: "Covers", render: (p) => p.note || `${p.capabilities.length} capabilities` },
          { key: "min", label: "Calls/min", align: "right", render: (p) => fmtNum(p.usage.lastMinute, 0) },
          { key: "day", label: "Calls 24h", align: "right", render: (p) => fmtNum(p.usage.last24h, 0) },
          { key: "err", label: "Errors", align: "right", render: (p) => <span className={p.usage.errors24h ? "yellow" : ""}>{fmtNum(p.usage.errors24h, 0)}</span> },
          { key: "ms", label: "Avg ms", align: "right", render: (p) => fmtNum(p.usage.avgMs, 0) },
          { key: "limit", label: "Free limit", align: "right", render: (p) => limitText(p.usage) },
          { key: "thr", label: "Skipped", align: "right", render: (p) => fmtNum(p.usage.throttled, 0) },
        ]}
      />
      <KeyValues
        items={[
          ["AI analyst", d.ai ? `${d.ai.provider} / ${d.ai.model}` : "off"],
          ["Plugins", d.plugins.length ? d.plugins.map((p) => `${p.name} (${[...p.functions, ...p.providers.map((x) => `provider ${x}`)].join(", ")})`).join("; ") : "none"],
          ["Sign-in", d.signIn ? "required (AUTH=password)" : "off: anyone who can reach this server can use any name"],
        ]}
        columns={1}
      />
      {d.suggestions.length > 0 && (
        <>
          <Section title="Free Upgrades" right="Optional, no cost" />
          <DataTable
            panel={panel}
            paged={false}
            testId="src-suggestions"
            rows={d.suggestions}
            columns={[
              { key: "n", label: "Add", render: (s) => <span className="white">{s.name}</span> },
              { key: "u", label: "Unlocks", render: (s) => s.unlocks },
              { key: "h", label: "How", render: (s) => s.how },
            ]}
          />
        </>
      )}
    </div>
  );
}
