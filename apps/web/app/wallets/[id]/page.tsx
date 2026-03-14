import { LayoutShell } from '../../components/layout-shell';
import { WalletDetailClient } from '../../components/wallet-detail-client';

export default async function WalletDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <LayoutShell>
            <WalletDetailClient walletId={id} />
        </LayoutShell>
    );
}
