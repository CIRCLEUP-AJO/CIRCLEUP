import type { Metadata } from "next";
import CreateClient from "./CreateClient";

export const metadata: Metadata = {
  title: "Create a Circle",
  description:
    "Set up a trustless savings circle on Stellar. Choose members, contribution amount, and round duration. The smart contract holds all funds.",
  alternates: {
    canonical: "/create",
  },
  openGraph: {
    title: "Create a Savings Circle — CircleUp",
    description:
      "Set up a trustless savings circle on Stellar. Choose members, contribution amount, and round duration.",
    url: "/create",
    type: "website",
  },
};

export default function CreatePage() {
  return <CreateClient />;
}
