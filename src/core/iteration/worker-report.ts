export type SelfReport = {
  errorReason?: string;
  thinking?: string;
  nextAction?: string;
  hadSections: boolean;
};

function normalizeSectionKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "_");
}

export function extractSelfReport(text: string): { report: SelfReport; userFacingOutput: string } {
  const lines = text.split(/\r?\n/);
  const sections: Record<"ERROR_REASON" | "THINKING" | "NEXT_ACTION", string[]> = {
    ERROR_REASON: [],
    THINKING: [],
    NEXT_ACTION: []
  };
  let current: keyof typeof sections | null = null;
  const outputLines: string[] = [];
  let hadSections = false;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      const key = normalizeSectionKey(match[1] || "");
      if (key in sections) {
        current = key as keyof typeof sections;
        hadSections = true;
        continue;
      }
      current = null;
      outputLines.push(line);
      continue;
    }

    if (current) {
      sections[current].push(line);
    } else {
      outputLines.push(line);
    }
  }

  const trimSection = (items: string[]): string | undefined => {
    const value = items.join("\n").trim();
    return value.length > 0 ? value : undefined;
  };

  const userFacingOutput = outputLines.join("\n").trim();

  return {
    report: {
      errorReason: trimSection(sections.ERROR_REASON),
      thinking: trimSection(sections.THINKING),
      nextAction: trimSection(sections.NEXT_ACTION),
      hadSections
    },
    userFacingOutput: hadSections ? userFacingOutput : text.trim()
  };
}
