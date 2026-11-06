/**
 * MOGUL-D040 P2 / OD-5 — "the owner has to approve this" from a workspace pod.
 *
 * When common-api enforces the pod-token boundary, an account-wide request made
 * from a pod (re-linking a deploy project, a domain change, registering or
 * uploading a personal app, a prod ship with the hosting gate off) is not run:
 * it is staged as an owner approval and answered with
 *
 *   202 { ok:false, reason:'approval-required', code:'POD_OWNER_APPROVAL_REQUESTED',
 *         approvalId, statement, expiresAt, pollPath, hint }
 *
 * The owner approves it in Studio (the deploy approval card) and it then runs AS
 * THE OWNER. So the CLI must NOT treat the 202 as success (nothing happened yet)
 * and must NOT resend the request (the approval runs it).
 */

export const POD_OWNER_APPROVAL_CODE = 'POD_OWNER_APPROVAL_REQUESTED';

export interface OwnerApprovalRequested {
  approvalId: string;
  statement?: string;
  expiresAt?: string;
  message: string;
  hint?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The staged-approval answer, or null for any other response. */
export function ownerApprovalRequestedOf(status: number, body: unknown): OwnerApprovalRequested | null {
  if (status !== 202 || !body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.code !== POD_OWNER_APPROVAL_CODE) return null;
  const approvalId = str(b.approvalId);
  if (!approvalId) return null;
  return {
    approvalId,
    ...(str(b.statement) ? { statement: str(b.statement) } : {}),
    ...(str(b.expiresAt) ? { expiresAt: str(b.expiresAt) } : {}),
    message: str(b.message) ?? 'Owner approval requested in Studio.',
    ...(str(b.hint) ? { hint: str(b.hint) } : {}),
  };
}

/** The PENDING block the CLI prints (exit 3, like a prod-ship approval). */
export function formatOwnerApprovalPending(a: OwnerApprovalRequested, what = 'this request'): string {
  return [
    `PENDING [awaiting-approval]: ${what} needs the workspace owner's approval (approval ${a.approvalId}).`,
    ...(a.statement ? [`  asks: ${a.statement}`] : []),
    `  approve: the owner approves it in Studio (notification / Approvals panel)${a.expiresAt ? ` before ${a.expiresAt}` : ''}.`,
    '  then: it runs AS THE OWNER on approval. Do not rerun the command for this step;',
    '  MCP callers can poll deploy.approval_status with the approval id.',
  ].join('\n');
}
