import { strict as assert } from "node:assert";
import {
  consumeFlowControlDelta,
  createDefaultFlowControl,
  createFlowControlStreamState,
  extractFlowControl,
  mergeFlowControl,
  parseFlowControl,
  stripFlowControl,
} from "../flow-control.js";

const taggedControl = `<flow_control>{"next":{"runSqlAudit":false,"skipAuditItems":["execution_flow_audited","owner_contact_audited","bad_item"]},"stream":{"coverPrevious":true}}</flow_control>结论：不涉及 SQL。`;
const extracted = extractFlowControl(taggedControl);

assert.equal(extracted.content, "结论：不涉及 SQL。", "flow_control tag should be stripped from visible content");
assert.equal(extracted.hasControl, true, "tagged flow_control should be detected");
assert.equal(extracted.control.next?.runSqlAudit, false, "runSqlAudit=false should be parsed");
assert.deepEqual(
  extracted.control.next?.skipAuditItems,
  ["execution_flow_audited", "owner_contact_audited"],
  "skipAuditItems should parse known audit ids and filter invalid ids",
);
assert.equal(extracted.control.stream?.coverPrevious, true, "coverPrevious=true should be parsed");

const defaultControl = createDefaultFlowControl();
assert.equal(defaultControl.next.runSqlAudit, true, "SQL audit should run by default");
assert.equal(defaultControl.stream.coverPrevious, false, "stream should not cover previous content by default");
assert.equal(defaultControl.stream.mode, "append", "stream should append by default");

const merged = mergeFlowControl(defaultControl, extracted.control);
assert.equal(merged.next.runSqlAudit, false, "merge should keep explicit runSqlAudit=false");
assert.deepEqual(
  mergeFlowControl(merged, { next: { skipAuditItems: ["owner_contact_audited", "final_format_audited"] } }).next.skipAuditItems,
  ["execution_flow_audited", "owner_contact_audited", "final_format_audited"],
  "merge should keep skipAuditItems unique and append new skipped nodes",
);
assert.equal(merged.stream.coverPrevious, true, "merge should keep explicit coverPrevious=true");

assert.equal(
  stripFlowControl(`{"flow_control":{"next":{"runSqlAudit":false}}}`),
  `{"flow_control":{"next":{"runSqlAudit":false}}}`,
  "bare JSON should remain visible unless it is wrapped in the flow_control tag",
);

assert.deepEqual(
  parseFlowControl("<flow_control>{bad json}</flow_control>结论保留"),
  {},
  "invalid flow_control JSON should fall back safely",
);

assert.equal(
  stripFlowControl("<flow_control>{bad json}</flow_control>结论保留"),
  "结论保留",
  "invalid flow_control tag should still be hidden from users",
);

const streamState = createFlowControlStreamState();
const firstChunk = consumeFlowControlDelta("<flow_control>{\"next\":{\"run", streamState);
assert.equal(firstChunk.content, "", "partial opening flow_control chunk should not be visible");
assert.equal(firstChunk.hasControl, false, "partial control should not be applied before closing tag");

const secondChunk = consumeFlowControlDelta("SqlAudit\":false},\"stream\":{\"coverPrevious\":true}}</flow_control>新的结论", streamState);
assert.equal(secondChunk.content, "新的结论", "visible content after split flow_control should remain");
assert.equal(secondChunk.control.next?.runSqlAudit, false, "split runSqlAudit=false should be parsed");
assert.equal(secondChunk.control.stream?.coverPrevious, true, "split coverPrevious=true should be parsed");

const tagSplitState = createFlowControlStreamState();
const partialTag = consumeFlowControlDelta("prefix <flow_co", tagSplitState);
assert.equal(partialTag.content, "prefix ", "partial open tag name should not leak");
assert.equal(partialTag.hasControl, false, "partial open tag name should not apply control");
const restOfTag = consumeFlowControlDelta("ntrol>{\"next\":{\"runSqlAudit\":false}}</flow_control>visible", tagSplitState);
assert.equal(restOfTag.content, "visible", "content after reassembled split tag name should remain");
assert.equal(restOfTag.control.next?.runSqlAudit, false, "split tag name control should be parsed");

assert.deepEqual(
  parseFlowControl("İ 前缀 <flow_control>{\"stream\":{\"coverPrevious\":true}}</flow_control>"),
  { stream: { coverPrevious: true } },
  "unicode before tag should not affect tag index parsing",
);

assert.deepEqual(
  parseFlowControl("<Flow_Control>{\"next\":{\"runSqlAudit\":false}}</Flow_Control>"),
  {},
  "mixed-case protocol tags should not be treated as valid directives",
);

assert.equal(
  stripFlowControl("A<flow_control>B<flow_control>C"),
  "A",
  "multiple unclosed flow_control tags should be stripped from the first unclosed tag",
);

console.log("flow control 协议验证通过");
