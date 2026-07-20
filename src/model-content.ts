export function stringifyModelContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(stringifyModelContent)
      .filter(Boolean)
      .join("\n");
  }

  if (typeof content === "object") {
    const record = content as Record<string, unknown>;
    if ("text" in record) return stringifyModelContent(record.text);
    if ("content" in record) return stringifyModelContent(record.content);
    return "";
  }

  return String(content);
}
