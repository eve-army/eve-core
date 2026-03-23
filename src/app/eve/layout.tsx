import type { Metadata } from "next";

/** Avoid stale HTML when switching dev/prod or rebuilding (chunk name mismatches). */
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  title: "EVE - Pump Fun Assistant",
  icons: {
    icon: "/clawk-favicon.png",
    apple: "/clawk-favicon.png",
  },
};

export default function PumpfunLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
