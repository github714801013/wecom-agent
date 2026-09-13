import {
  buildSensitiveRequestBlockedReply,
  judgeSensitiveRequestByModel,
  type SensitiveJudgeModel,
  type SensitiveRequestDecision,
} from "./sensitive-request-guard.js";

export type SensitiveCredentialDecision = SensitiveRequestDecision;

export function evaluateSensitiveCredentialRequest(text: string, model?: SensitiveJudgeModel): Promise<SensitiveRequestDecision> {
  return judgeSensitiveRequestByModel(text, model);
}

export function buildSensitiveCredentialBlockedReply(): string {
  return buildSensitiveRequestBlockedReply();
}
