"use client";

interface ReputationBadgeProps {
  score: number;
  size?: "sm" | "md" | "lg";
}

function getLevel(score: number): { label: string; color: string; emoji: string } {
  if (score === 0)  return { label: "New",      color: "bg-slate-100 text-slate-600",    emoji: "🌱" };
  if (score < 3)   return { label: "Starter",   color: "bg-yellow-100 text-yellow-700",  emoji: "⭐" };
  if (score < 6)   return { label: "Reliable",  color: "bg-blue-100 text-blue-700",      emoji: "💎" };
  if (score < 10)  return { label: "Trusted",   color: "bg-brand-100 text-brand-700",    emoji: "🏆" };
  return              { label: "Legend",    color: "bg-purple-100 text-purple-700",  emoji: "👑" };
}

export function ReputationBadge({ score, size = "md" }: ReputationBadgeProps) {
  const level = getLevel(score);
  const sizeClass = size === "sm" ? "text-xs px-2 py-0.5" : size === "lg" ? "text-base px-4 py-2" : "text-sm px-3 py-1";

  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${level.color} ${sizeClass}`}>
      <span>{level.emoji}</span>
      <span>{level.label}</span>
      <span className="font-bold">{score}</span>
    </span>
  );
}
