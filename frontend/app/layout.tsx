import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sync Platform - Dashboard',
  description: 'Real-time Google Sheets ↔ MySQL sync platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50">{children}</body>
    </html>
  );
}
