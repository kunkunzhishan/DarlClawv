import YAML from "yaml";

export function parseYaml<T>(content: string, source: string): T {
  try {
    return YAML.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`YAML parse error in ${source}: ${message}`);
  }
}

export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value);
}
