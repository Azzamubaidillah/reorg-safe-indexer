import { PageTitle } from "../../components/ui.tsx";
import { QualityView } from "../../components/quality.tsx";

export const metadata = { title: "Data quality" };

export default function Page() {
  return (
    <>
      <PageTitle lead="A range is published only when every block is finalized and every data-quality gate passed. Failed ranges stay unpublished and queue a backfill job.">
        Data quality
      </PageTitle>
      <QualityView />
    </>
  );
}
