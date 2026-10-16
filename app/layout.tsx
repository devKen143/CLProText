import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'CLProText — Your personal notebook', description: 'A quiet space for your thoughts. Encrypted in your browser.', robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }
