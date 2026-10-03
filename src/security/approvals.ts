import type { Risk } from "../tools/tool.ts";

export type Decision = "approve" | "approve_session" | "deny";

export interface ApprovalRequest {
  tool: string;
  summary: string;
  risk: Risk;
  /** Extra detail such as a diff of a file write. */
  preview?: string;
}

/** A channel's way of asking the user (CLI prompt now; Telegram buttons in Phase 5). */
export interface Approver {
  ask(request: ApprovalRequest): Promise<Decision>;
}

/** How a call was allowed or refused — recorded in the audit log. */
export type Verdict = "auto" | "session" | "plan" | "approved" | "denied" | "blocked";

/**
 * I-4 policy: blocked → never; low → run; medium → ask unless already allowed
 * for this session or by an approved plan (I-2); high → always ask.
 */
export class ApprovalPolicy {
  private sessionScopes = new Set<string>();
  private planScopes = new Set<string>();

  async authorize(request: ApprovalRequest, approver: Approver): Promise<Verdict> {
    const { risk } = request;
    if (risk.level === "blocked") return "blocked";
    if (risk.level === "low") return "auto";
    if (risk.level === "medium" && !risk.tainted) {
      if (this.sessionScopes.has(risk.scope)) return "session";
      if (this.planScopes.has(risk.scope)) return "plan";
    }

    const decision = await approver.ask(request);
    if (decision === "deny") return "denied";
    if (decision === "approve_session" && risk.sessionApprovable) this.sessionScopes.add(risk.scope);
    return "approved";
  }

  /** Marks scopes as "always allow" for this session, as if the user had chosen that (tests and evaluation). */
  allowForSession(scopes: Iterable<string>): void {
    for (const scope of scopes) this.sessionScopes.add(scope);
  }

  /** I-2: pre-approve the scopes of an accepted plan (medium-risk calls only). */
  allowPlan(scopes: Iterable<string>): void {
    this.planScopes = new Set(scopes);
  }

  clearPlan(): void {
    this.planScopes.clear();
  }

  /** Forget all session approvals (e.g. on /new). */
  reset(): void {
    this.sessionScopes.clear();
    this.planScopes.clear();
  }
}
