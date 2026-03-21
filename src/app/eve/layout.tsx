import type { Metadata } from "next";

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
