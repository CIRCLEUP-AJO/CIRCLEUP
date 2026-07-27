import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ReputationClient from "./ReputationClient";

export async function generateMetadata({
  params,
}: {
  params: { member: string };
}): Promise<Metadata> {
  return {
    title: `Reputation: ${params.member.slice(0, 8)}… — CircleUp`,
    description: `On-chain reputation and contribution history for Stellar address ${params.member} on CircleUp.`,
  };
}

export default function ReputationPage({
  params,
}: {
  params: { member: string };
}) {
  if (!/^G[A-Z2-7]{55}$/.test(params.member)) {
    notFound();
  }
  return <ReputationClient member={params.member} />;
}
