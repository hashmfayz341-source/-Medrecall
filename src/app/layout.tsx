import type { Metadata, Viewport } from "next";
import "./globals.css";
import { LearnerProvider } from "@/components/LearnerProvider";

export const metadata: Metadata = {
  title: "MedRecall",
  description:
    "An adaptive medical curriculum tutor built around concepts, not flashcards.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full font-sans antialiased">
        <LearnerProvider>{children}</LearnerProvider>
      </body>
    </html>
  );
}
