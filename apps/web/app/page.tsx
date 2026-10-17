import { OverviewView } from "../components/overview.tsx";
import { PageTitle } from "../components/ui.tsx";

export const metadata = { title: "Overview" };

export default function Page() {
  return (
    <>
      <PageTitle lead="Where the indexer is relative to the chain, what has been published, and what went wrong most recently.">Overview</PageTitle>
      <OverviewView />
    </>
  );
}
