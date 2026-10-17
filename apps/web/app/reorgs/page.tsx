import { PageTitle } from "../../components/ui.tsx";
import { ReorgsView } from "../../components/reorgs.tsx";

export const metadata = { title: "Reorgs" };

export default function Page() {
  return (
    <>
      <PageTitle lead="Every detected chain reorganisation, newest first. Orphaned blocks were stored and then removed; canonical blocks replaced them.">Reorgs</PageTitle>
      <ReorgsView />
    </>
  );
}
