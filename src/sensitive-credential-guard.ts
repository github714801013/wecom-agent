import {
  buildSensitiveRequestBlockedReply,
  detectSensitiveCredentialRequest,
  type SensitiveRequestDecision,
} from "./sensitive-request-guard.js";

export type SensitiveCredentialDecision = SensitiveRequestDecision;

export function evaluateSensitiveCredentialRequest(text: string): SensitiveRequestDecision {
  return detectSensitiveCredentialRequest(text);
}

export function buildSensitiveCredentialBlockedReply(): string {
  return buildSensitiveRequestBlockedReply();
}
