import { PageTitle } from "../../components/ui.tsx";
import { AnalyticsView } from "../../components/analytics.tsx";

export const metadata = { title: "Analytics" };

export default function Page() {
  return (
    <>
      <PageTitle lead="Daily volume, active addresses and pool prices computed from the Parquet export of published ranges.">Analytics</PageTitle>
      <AnalyticsView />
    </>
  );
}
