import type { ReactNode } from "react";
import { ApiError, useQuote } from "../api";
import { SecurityHeader } from "./SecurityHeader";

/** Loads a security's quote and renders its header above `children`. */
export function SecurityScreen({ security, children }: { security: string; children: ReactNode }) {
  const { data, error, loading } = useQuote(security);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="error-box" data-testid="unknown-security">
        UNKNOWN SECURITY: {security}
        <div className="screen-note">Check the ticker, exchange code, and yellow key, then press &lt;GO&gt;.</div>
      </div>
    );
  }

  return (
    <>
      {data ? (
        <SecurityHeader quote={data} />
      ) : (
        <div className="sec-header gray">{loading ? "LOADING..." : "DATA SOURCE UNAVAILABLE"}</div>
      )}
      {error && data && <div className="cmdline-message">DATA SOURCE UNAVAILABLE. SHOWING LAST VALUE</div>}
      {children}
    </>
  );
}
