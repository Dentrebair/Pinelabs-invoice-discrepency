// Guard for model-written prose: accept it only if every number it contains appears in the facts
// the model was given and it cites at least one real document number.
const digitGroups = (text: string) => new Set(text.replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []);

// "10,000.00" in the facts must also allow "10,000" / "10000" in prose.
const withoutZeroDecimals = (s: Set<string>) => new Set([...s].flatMap((n) => (n.endsWith(".00") ? [n, n.slice(0, -3)] : [n])));

export function isGrounded(text: string, facts: string, documentNumbers: string[]): boolean {
  if (!text.trim()) return false;
  const allowed = withoutZeroDecimals(digitGroups(facts));
  for (const n of digitGroups(text)) if (!allowed.has(n)) return false;
  return documentNumbers.some((d) => text.includes(d));
}
