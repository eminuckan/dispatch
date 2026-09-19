// Version 1 catalog: keep ordering and rotation fixed so persisted spawn identities
// retain their display names. Repeated catalogs get a numeric suffix.
const NAMES = [
  "Curie",
  "Turing",
  "Lovelace",
  "Kepler",
  "Noether",
  "Faraday",
  "Hopper",
  "Galileo",
  "Franklin",
  "Darwin",
  "Sagan",
  "Euler",
  "Hypatia",
  "Feynman",
  "Ramanujan",
  "Hubble",
];
export function teamAgentDisplayName(
  runId: string,
  spawnOrder: ReadonlyArray<string>,
  threadId: string,
): string {
  const index = [...new Set(spawnOrder)].indexOf(threadId);
  if (index < 0) return "Worker";
  const offset =
    [...runId].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0) % 16;
  return `${NAMES[(offset + index) % 16]}${index >= 16 ? ` ${Math.floor(index / 16) + 1}` : ""}`;
}
