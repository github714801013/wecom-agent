import { strict as assert } from "node:assert";
import {
  buildSensitiveCredentialBlockedReply,
  evaluateSensitiveCredentialRequest,
} from "../sensitive-credential-guard.js";
import {
  buildSensitiveRequestBlockedReply,
  detectSensitiveCredentialRequest,
} from "../sensitive-request-guard.js";

const samples = [
  "某系统的账号密码",
  "如何重置账号密码",
  "accessToken=null 是什么原因",
];

for (const sample of samples) {
  assert.deepEqual(
    evaluateSensitiveCredentialRequest(sample),
    detectSensitiveCredentialRequest(sample),
    "兼容入口必须复用统一敏感请求守卫",
  );
}

assert.equal(
  buildSensitiveCredentialBlockedReply(),
  buildSensitiveRequestBlockedReply(),
  "兼容回复必须复用统一安全文案",
);

console.log("sensitive credential guard 兼容入口验证通过");
