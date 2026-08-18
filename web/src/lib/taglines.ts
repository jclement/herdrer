/**
 * Deadpan sysadmin register: 3–8 words, sentence case, full stop. One per day,
 * chosen by a stable hash of the date so it doesn't flicker between renders.
 */
export const TAGLINES = [
  "Somebody has to hold the leashes.",
  "Your agents are asking for you.",
  "Two taps beat one SSH session.",
  "The meat is the bottleneck.",
  "Blocked is not the same as done.",
  "A timeout is not a yes.",
  "Reads diffs at bus stops.",
  "Herding the things that herd the things.",
  "It buzzed for a reason.",
  "Approve responsibly.",
  "Yes, from a phone, on a train.",
  "Now with considerably more thumbs.",
  "The queue is shorter than it looks.",
  "One human, several impatient processes.",
  "Everything is fine until it asks.",
  "Small screen, consequential buttons.",
  "Answers travel faster than context.",
  "Waiting is expensive; deciding is cheap.",
  "Someone still has to say yes.",
  "The pager, but for opinions.",
] as const;

export function taglineForDate(d: Date = new Date()): string {
  const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % TAGLINES.length;
  return TAGLINES[idx] ?? TAGLINES[0];
}
