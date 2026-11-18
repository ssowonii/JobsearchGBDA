import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Internship Hub',
  description: 'Personal internship crawler + tracker with RAG search (marketing, content, UX/UI) for Ontario',
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%235b3fd1%22/%3E%3Cpath d=%22M9 12h14v11H9z%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222.4%22 stroke-linejoin=%22round%22/%3E%3Cpath d=%22M13 12V9h6v3%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222.4%22/%3E%3C/svg%3E",
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
