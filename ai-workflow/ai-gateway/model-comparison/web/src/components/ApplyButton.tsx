import { useState } from "react";
import { applyRoleChanges, canApplyRoles, type ApplyResult, type RoleChange } from "../lib/applyRoles";

interface Props {
  changes: RoleChange[];
  /** Button text, e.g. "Apply" or "Apply 4 changes". */
  label: string;
  onApplied: (result: ApplyResult) => void;
  className?: string;
}

// Writes picks into the Herdr config in two steps, without a browser dialog:
// the first click asks inline ("Write to Herdr?"), the second writes. The
// server keeps a backup and changes only model and variant of those roles.
export function ApplyButton({ changes, label, onApplied, className = "" }: Props) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!canApplyRoles() || changes.length === 0) return null;
  const n = changes.length;
  const run = async () => {
    setStep("busy");
    setError(null);
    try {
      onApplied(await applyRoleChanges(changes));
      setStep("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("confirm");
    }
  };
  if (step === "idle") {
    return <button type="button" className={`apply-button ${className}`} onClick={(e) => { e.stopPropagation(); setStep("confirm"); }}>{label}</button>;
  }
  return <span className={`apply-confirm ${className}`} role="group" aria-label="Confirm apply" onClick={(e) => e.stopPropagation()}>
    <span className="apply-question">{error ? <span className="apply-error">{error}</span> : <>Write {n === 1 ? "this model" : `${n} models`} to Herdr?</>}</span>
    <button type="button" className="apply-button" disabled={step === "busy"} onClick={run}>{step === "busy" ? "Writing…" : "Write"}</button>
    <button type="button" className="apply-cancel" disabled={step === "busy"} onClick={() => { setStep("idle"); setError(null); }}>Cancel</button>
  </span>;
}
