import { PageTitle } from "../../components/ui.tsx";
import { ExplorerView } from "../../components/explorer.tsx";

export const metadata = { title: "Explorer" };

export default function Page() {
  return (
    <>
      <PageTitle lead="Decoded ERC-20 transfers and Uniswap v3 swaps. Only rows from published ranges are shown, newest first.">Explorer</PageTitle>
      <ExplorerView />
    </>
  );
}
