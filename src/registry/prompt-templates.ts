import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const PROMPT_ROOT = process.env.MYDARL_PROMPT_ROOT
  ? path.resolve(process.env.MYDARL_PROMPT_ROOT)
  : path.resolve("src", "config", "prompts");
const cache = new Map<string, string>();
const sectionCache = new Map<string, Map<string, string>>();

function normalizePromptText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolvePromptPath(templateId: string): string {
  const fileName = templateId.endsWith(".md") ? templateId : `${templateId}.md`;
  return path.join(PROMPT_ROOT, fileName);
}

export function loadPromptTemplate(templateId: string): string {
  const cached = cache.get(templateId);
  if (cached) {
    return cached;
  }

  const filePath = resolvePromptPath(templateId);
  if (!existsSync(filePath)) {
    throw new Error(`Prompt template not found: ${filePath}`);
  }

  const content = normalizePromptText(readFileSync(filePath, "utf8"));
  if (!content) {
    throw new Error(`Prompt template is empty: ${filePath}`);
  }

  cache.set(templateId, content);
  return content;
}

function renderPromptText(
  sourceLabel: string,
  templateText: string,
  values: Record<string, string | number | boolean | undefined>
): string {
  let rendered = templateText;
  for (const [key, value] of Object.entries(values)) {
    const token = `{{${key}}}`;
    rendered = rendered.replaceAll(token, value === undefined ? "" : String(value));
  }

  const unresolved = rendered.match(/{{[^{}]+}}/g);
  if (unresolved && unresolved.length > 0) {
    throw new Error(
      `Prompt template '${sourceLabel}' has unresolved variables: ${unresolved.join(", ")}`
    );
  }

  return normalizePromptText(rendered);
}

export function renderPromptTemplate(
  templateId: string,
  values: Record<string, string | number | boolean | undefined>
): string {
  return renderPromptText(templateId, loadPromptTemplate(templateId), values);
}

function loadPromptSections(templateId: string): Map<string, string> {
  const cached = sectionCache.get(templateId);
  if (cached) {
    return cached;
  }

  const content = loadPromptTemplate(templateId);
  const pattern = /^##\s+(.+)$/gm;
  const headers: Array<{ name: string; index: number; lineLength: number }> = [];
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match) {
    headers.push({
      name: (match[1] || "").trim().toLowerCase(),
      index: match.index,
      lineLength: (match[0] || "").length
    });
    match = pattern.exec(content);
  }

  const sections = new Map<string, string>();
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i];
    const next = headers[i + 1];
    const start = current.index + current.lineLength;
    const end = next ? next.index : content.length;
    const body = normalizePromptText(content.slice(start, end));
    if (body) {
      sections.set(current.name, body);
    }
  }

  sectionCache.set(templateId, sections);
  return sections;
}

export function loadPromptSection(templateId: string, sectionName: string): string {
  const key = sectionName.trim().toLowerCase();
  const section = loadPromptSections(templateId).get(key);
  if (!section) {
    throw new Error(`Prompt template section not found: ${templateId}#${sectionName}`);
  }
  return section;
}

export function renderPromptSection(
  templateId: string,
  sectionName: string,
  values: Record<string, string | number | boolean | undefined>
): string {
  const section = loadPromptSection(templateId, sectionName);
  return renderPromptText(`${templateId}#${sectionName}`, section, values);
}
