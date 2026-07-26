"use client";

export interface ReputationBadgeProps {
  score: number;
  size?: "sm" | "md" | "lg";
}

export interface ReputationLevel {
  label: string;
  color: string;
  emoji: string;
  /** Minimum score required to reach this level (inclusive). */
  minScore: number;
  /** Maximum score for this level (exclusive), or Infinity for the top tier. */
  maxScore: number;
  description: string;
}

/** Ordered tier definitions — used both for badge rendering and the legend. */
export const REPUTATION_LEVELS: ReputationLevel[] = [
  {
    label: "New",
    color: "bg-slate-100 text-slate-600",
    emoji: "🌱",
    minScore: 0,
    maxScore: 1,
    description: "No completed rounds yet.",
  },
  {
    label: "Starter",
    color: "bg-yellow-100 text-yellow-700",
    emoji: "⭐",
    minScore: 1,
    maxScore: 3,
    description: "1–2 completed rounds.",
  },
  {
    label: "Reliable",
    color: "bg-blue-100 text-blue-700",
    emoji: "💎",
    minScore: 3,
    maxScore: 6,
    description: "3–5 completed rounds.",
  },
  {
    label: "Trusted",
    color: "bg-brand-100 text-brand-700",
    emoji: "🏆",
    minScore: 6,
    maxScore: 10,
    description: "6–9 completed rounds.",
  },
  {
    label: "Legend",
    color: "bg-purple-100 text-purple-700",
    emoji: "👑",
    minScore: 10,
    maxScore: Infinity,
    description: "10 or more completed rounds.",
  },
];

export function getLevel(score: number): ReputationLevel {
  // Walk tiers in reverse so we always match the highest qualifying tier.
  for (let i = REPUTATION_LEVELS.length - 1; i >= 0; i--) {
    if (score >= REPUTATION_LEVELS[i].minScore) {
      return REPUTATION_LEVELS[i];
    }
  }
  return REPUTATION_LEVELS[0];
}

export function ReputationBadge({ score, size = "md" }: ReputationBadgeProps) {
  const level = getLevel(score);
  const sizeClass =
    size === "sm"
      ? "text-xs px-2 py-0.5"
      : size === "lg"
      ? "text-base px-4 py-2"
      : "text-sm px-3 py-1";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${level.color} ${sizeClass}`}
      // Provide a meaningful accessible label so screen readers announce
      // "Reputation: Legend, score 12" instead of reading the emoji and
      // label text literally as separate tokens.
      aria-label={`Reputation level: ${level.label}, score ${score}`}
      title={`${level.label} — ${level.description}`}
    >
      <span aria-hidden="true">{level.emoji}</span>
      <span aria-hidden="true">{level.label}</span>
      <span aria-hidden="true" className="font-bold">
        {score}
      </span>
    </span>
  );
}

/**
 * ReputationLegend — renders a full tier table explaining each badge level.
 * Intended for the reputation profile page to help users understand the scoring
 * system. Uses a <dl> (description list) for semantic correctness.
 */
export function ReputationLegend() {
  return (
    <section
      aria-label="Reputation badge legend"
      className="bg-white rounded-xl border border-slate-200 p-5"
    >
      <h2 className="font-semibold text-slate-800 mb-3">Badge levels</h2>
      <dl className="space-y-2">
        {REPUTATION_LEVELS.map((tier) => (
          <div
            key={tier.label}
            className="flex items-center gap-3"
          >
            <dt className="shrink-0">
              <span
                className={`inline-flex items-center gap-1 rounded-full font-medium text-xs px-2 py-0.5 ${tier.color}`}
                aria-hidden="true"
              >
                <span>{tier.emoji}</span>
                <span>{tier.label}</span>
              </span>
            </dt>
            <dd className="text-sm text-slate-500">{tier.description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
