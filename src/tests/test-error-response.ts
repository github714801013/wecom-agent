import { strict as assert } from "node:assert";
import {
  buildDiagnosticErrorFields,
  buildUserFacingErrorReply,
  getErrorMessage,
  sanitizeErrorMessage,
} from "../error-response.js";

const balanceError = new Error("402 ... insufficient_balance ...");
assert.equal(getErrorMessage(balanceError), "402 ... insufficient_balance ...");
assert.equal(
  buildUserFacingErrorReply(balanceError),
  "处理请求时发生异常：402 ... insufficient_balance ...",
);

const diagnosticFields = buildDiagnosticErrorFields(balanceError);
assert.equal(diagnosticFields.error, "402 ... insufficient_balance ...");
assert.equal(diagnosticFields.answer, "处理请求时发生异常：402 ... insufficient_balance ...");

const credentialMessage = "request failed: api_key=sk-live-secret password=secret-value";
const sanitized = sanitizeErrorMessage(credentialMessage);
assert.doesNotMatch(sanitized, /sk-live-secret|secret-value/);
assert.match(sanitized, /api_key=\[已脱敏\]/);
assert.match(sanitized, /password=\[已脱敏\]/);

console.log("真实异常兜底响应验证通过");
