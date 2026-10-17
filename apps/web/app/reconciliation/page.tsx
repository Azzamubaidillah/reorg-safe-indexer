import { PageTitle } from "../../components/ui.tsx";
import { ReconciliationView } from "../../components/reconciliation.tsx";

export const metadata = { title: "Reconciliation" };

export default function Page() {
  return (
    <>
      <PageTitle lead="Finalized ranges re-read from a second provider. A mismatch without an explanation blocks the milestone gate.">Reconciliation</PageTitle>
      <ReconciliationView />
    </>
  );
}
