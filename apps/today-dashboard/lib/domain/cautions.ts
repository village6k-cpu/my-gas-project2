export function sanitizeCautionDisplayText(value: unknown): string {
  let text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";

  const evidenceParts = text.split(/[;；]/).map((part) => part.trim()).filter(Boolean);
  if (evidenceParts.length > 1) text = evidenceParts[evidenceParts.length - 1] || "";

  return text
    .replace(/^분류\s*:\s*[^.。;；]+[.。]\s*/i, "")
    .replace(/\bNotebookLM\s*:\s*/gi, "")
    .replace(/\bNotebookLM\b/gi, "")
    .replace(/\bkakao[-_\s]?\d{4}\b/gi, "")
    .replace(/\b카카오[-_\s]?\d{4}\b/gi, "")
    .replace(/\bcorrections?\.md\b/gi, "")
    .replace(/^[\s,.;:，、\/|_\-]+/g, "")
    .replace(/[\s,.;:，、\/|_\-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
