"use client";

export interface ContributionStatusBadgeProps {
  status: "contributed" | "pending" | "defaulted" | "not_applicable";
}

export function ContributionStatusBadge({ status }: ContributionStatusBadgeProps) {
  switch (status) {
    case "contributed":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
          <span aria-hidden="true">✔</span>
          <span className="sr-only">Contribution status: </span>
          contributed
        </span>
      );
    case "pending":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
          <span aria-hidden="true">⚠</span>
          <span className="sr-only">Contribution status: </span>
          pending
        </span>
      );
    case "defaulted":
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
          <span aria-hidden="true">✗</span>
          <span className="sr-only">Contribution status: </span>
          defaulted
        </span>
      );
    case "not_applicable":
    default:
      return (
        <span className="text-slate-400 text-xs">
          <span className="sr-only">Contribution status: </span>
          waiting
        </span>
      );
  }
}
