// Order matters: the Anthropic key pattern must run before the generic one
const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "gitlab-token", pattern: /glpat-[A-Za-z0-9_-]{20,}/g },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._-]+/gi },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9._-]{20,}/g },
];

/**
 * Masks well-known secret formats before a text is stored
 *
 * @param   text  Text written by a person
 *
 * @return  The text with each secret replaced by a marker
 */
export function redactSecrets(text: string): string {
  return RULES.reduce(
    (result, rule) => result.replace(rule.pattern, `[REDACTED:${rule.name}]`),
    text,
  );
}
