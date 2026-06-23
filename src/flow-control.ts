export type FlowStreamMode = "append" | "replace";
export type FlowSkippableAuditItem =
  | "project_scope_audited"
  | "sql_correctness_audited"
  | "evidence_audited"
  | "execution_flow_audited"
  | "owner_contact_audited"
  | "final_format_audited";

export interface FlowControlDecision {
  stream: {
    mode: FlowStreamMode;
    coverPrevious: boolean;
  };
  next: {
    runSqlAudit: boolean;
    skipAuditItems: FlowSkippableAuditItem[];
  };
}

export interface FlowControlPatch {
  stream?: {
    mode?: FlowStreamMode;
    coverPrevious?: boolean;
  };
  next?: {
    runSqlAudit?: boolean;
    skipAuditItems?: FlowSkippableAuditItem[];
  };
}

export interface FlowControlExtraction {
  content: string;
  control: FlowControlPatch;
  hasControl: boolean;
}

export interface FlowControlStreamState {
  pending: string;
}

const FLOW_CONTROL_OPEN_TAG = "<flow_control>";
const FLOW_CONTROL_CLOSE_TAG = "</flow_control>";
const FLOW_CONTROL_BLOCK_PATTERN = /<flow_control>\s*([\s\S]*?)\s*<\/flow_control>/gu;
const JSON_CODE_FENCE_PATTERN = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu;
const SKIPPABLE_AUDIT_ITEMS = new Set<FlowSkippableAuditItem>([
  "project_scope_audited",
  "sql_correctness_audited",
  "evidence_audited",
  "execution_flow_audited",
  "owner_contact_audited",
  "final_format_audited",
]);

export function createDefaultFlowControl(): FlowControlDecision {
  return {
    stream: {
      mode: "append",
      coverPrevious: false,
    },
    next: {
      runSqlAudit: true,
      skipAuditItems: [],
    },
  };
}

export function createFlowControlStreamState(): FlowControlStreamState {
  return { pending: "" };
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(JSON_CODE_FENCE_PATTERN);
  const jsonText = fenced ? fenced[1]!.trim() : trimmed;
  if (!jsonText.startsWith("{") || !jsonText.endsWith("}")) return undefined;

  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function toFlowControlPatch(value: unknown): FlowControlPatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const source = root.flow_control && typeof root.flow_control === "object" && !Array.isArray(root.flow_control)
    ? root.flow_control as Record<string, unknown>
    : root;

  const patch: FlowControlPatch = {};
  const stream = source.stream;
  if (stream && typeof stream === "object" && !Array.isArray(stream)) {
    const streamPatch: NonNullable<FlowControlPatch["stream"]> = {};
    const streamObj = stream as Record<string, unknown>;
    if (streamObj.mode === "append" || streamObj.mode === "replace") {
      streamPatch.mode = streamObj.mode;
    }
    if (typeof streamObj.coverPrevious === "boolean") {
      streamPatch.coverPrevious = streamObj.coverPrevious;
    }
    if (Object.keys(streamPatch).length > 0) patch.stream = streamPatch;
  }

  const next = source.next;
  if (next && typeof next === "object" && !Array.isArray(next)) {
    const nextPatch: NonNullable<FlowControlPatch["next"]> = {};
    const nextObj = next as Record<string, unknown>;
    if (typeof nextObj.runSqlAudit === "boolean") {
      nextPatch.runSqlAudit = nextObj.runSqlAudit;
    }
    if (Array.isArray(nextObj.skipAuditItems)) {
      const skipAuditItems = nextObj.skipAuditItems
        .filter((item): item is FlowSkippableAuditItem => typeof item === "string" && SKIPPABLE_AUDIT_ITEMS.has(item as FlowSkippableAuditItem));
      if (skipAuditItems.length > 0) {
        nextPatch.skipAuditItems = Array.from(new Set(skipAuditItems));
      }
    }
    if (Object.keys(nextPatch).length > 0) patch.next = nextPatch;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function mergePatch(previous: FlowControlPatch, next: FlowControlPatch | undefined): FlowControlPatch {
  if (!next) return previous;
  const stream = {
    ...(previous.stream || {}),
    ...(next.stream || {}),
  };
  const nextControl = {
    ...(previous.next || {}),
    ...(next.next || {}),
  };
  const merged: FlowControlPatch = {};
  if (Object.keys(stream).length > 0) merged.stream = stream;
  if (Object.keys(nextControl).length > 0) merged.next = nextControl;
  return merged;
}

export function parseFlowControl(content: string): FlowControlPatch {
  let control: FlowControlPatch = {};

  for (const match of content.matchAll(FLOW_CONTROL_BLOCK_PATTERN)) {
    const parsed = parseJsonObject(match[1] || "");
    control = mergePatch(control, toFlowControlPatch(parsed));
  }

  return control;
}

function hasPatchValue(control: FlowControlPatch) {
  return Boolean(control.stream || control.next);
}

function getTrailingOpenTagPrefixLength(content: string) {
  const maxLength = Math.min(content.length, FLOW_CONTROL_OPEN_TAG.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (content.endsWith(FLOW_CONTROL_OPEN_TAG.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export function stripFlowControl(content: string) {
  let stripped = content.replace(FLOW_CONTROL_BLOCK_PATTERN, "");
  const openIndex = stripped.indexOf(FLOW_CONTROL_OPEN_TAG);
  if (openIndex >= 0 && stripped.indexOf(FLOW_CONTROL_CLOSE_TAG, openIndex) === -1) {
    stripped = stripped.slice(0, openIndex);
  }

  return stripped;
}

export function extractFlowControl(content: string): FlowControlExtraction {
  const control = parseFlowControl(content);
  return {
    content: stripFlowControl(content),
    control,
    hasControl: hasPatchValue(control),
  };
}

export function mergeFlowControl(previous: FlowControlDecision, patch: FlowControlPatch): FlowControlDecision {
  return {
    stream: {
      mode: patch.stream?.mode ?? previous.stream.mode,
      coverPrevious: patch.stream?.coverPrevious ?? previous.stream.coverPrevious,
    },
    next: {
      runSqlAudit: patch.next?.runSqlAudit ?? previous.next.runSqlAudit,
      skipAuditItems: Array.from(new Set([
        ...previous.next.skipAuditItems,
        ...(patch.next?.skipAuditItems || []),
      ])),
    },
  };
}

export function consumeFlowControlDelta(delta: string, state: FlowControlStreamState): FlowControlExtraction {
  let remaining = state.pending + delta;
  let visibleContent = "";
  let control: FlowControlPatch = {};
  state.pending = "";

  while (remaining.length > 0) {
    const openIndex = remaining.indexOf(FLOW_CONTROL_OPEN_TAG);
    if (openIndex === -1) {
      const pendingPrefixLength = getTrailingOpenTagPrefixLength(remaining);
      if (pendingPrefixLength > 0) {
        visibleContent += remaining.slice(0, -pendingPrefixLength);
        state.pending = remaining.slice(-pendingPrefixLength);
      } else {
        visibleContent += remaining;
      }
      break;
    }

    visibleContent += remaining.slice(0, openIndex);
    const closeIndex = remaining.indexOf(FLOW_CONTROL_CLOSE_TAG, openIndex + FLOW_CONTROL_OPEN_TAG.length);
    if (closeIndex === -1) {
      state.pending = remaining.slice(openIndex);
      break;
    }

    const controlBody = remaining.slice(openIndex + FLOW_CONTROL_OPEN_TAG.length, closeIndex);
    const parsed = parseJsonObject(controlBody);
    control = mergePatch(control, toFlowControlPatch(parsed));
    remaining = remaining.slice(closeIndex + FLOW_CONTROL_CLOSE_TAG.length);
  }

  return {
    content: visibleContent,
    control,
    hasControl: hasPatchValue(control),
  };
}
