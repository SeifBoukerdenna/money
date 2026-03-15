import { LayoutShell } from "./layout-shell";
import { PolymarketProfileClient } from "./polymarket-profile-client";

export default async function WalletDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return (
        <LayoutShell>
            <PolymarketProfileClient walletId={id} />
        </LayoutShell>
    );
}