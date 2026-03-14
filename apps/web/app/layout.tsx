import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Polymarket Copy Trader',
    description: 'Production-style paper-first copy trading platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
