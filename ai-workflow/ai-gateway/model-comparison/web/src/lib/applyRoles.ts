// Writes Herdr role picks through the local server (POST api/roles/apply), which
// does what `cc-models recommend --apply` does: model and variant only, after a
// backup. Only available when the page is served by the local server.

export interface RoleChange {
  role: string;
  model: string;
  variant: string | null;
}

export interface ApplyResult {
  applied: { role: string; from: string; to: string }[];
  backup: string;
}

export function canApplyRoles(): boolean {
  return typeof window !== "undefined" && window.location.protocol !== "file:";
}

/** "acc-openai/gpt-6.2-sol-openai#high" -> { model, variant }. */
export function changeFor(role: string, id: string): RoleChange {
  const [model, variant] = id.split("#");
  return { role, model, variant: variant ?? null };
}

export async function applyRoleChanges(changes: RoleChange[]): Promise<ApplyResult> {
  const response = await fetch("./api/roles/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Model-Comparison": "apply" },
    body: JSON.stringify({ changes }),
  });
  const body = await response.json().catch(() => ({})) as Partial<ApplyResult> & { error?: string };
  if (!response.ok) throw new Error(body.error || `Apply failed (${response.status})`);
  return body as ApplyResult;
}
