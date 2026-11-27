import Link from "next/link";
import type { Metadata, Viewport } from "next";
import { Cinzel, Inter, JetBrains_Mono } from "next/font/google";
import { Atmosphere } from "../components/Atmosphere";
import { GhostCursor } from "../components/GhostCursor";
import { LazarusMark } from "../components/LazarusMark";
import { StillToggle } from "../components/StillToggle";
import { SOCIAL_IMAGE, siteUrl } from "../lib/site-url";
import { STILL_INIT_SCRIPT } from "../lib/ui/still-mode";
import "./globals.css";

const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

const DESCRIPTION =
  "Paste a WSDL. Get a live MCP server with automatic risk judgement, human approval for dangerous calls, and a ghost mode. Built with Kiro.";
const TITLE = "Lazarus: raise dead SOAP services as safe MCP servers";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: TITLE, template: "%s | Lazarus" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Lazarus",
    title: TITLE,
    description: DESCRIPTION,
    images: [SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: SOCIAL_IMAGE.url, alt: SOCIAL_IMAGE.alt }],
  },
  icons: {
    icon: [
      { url: "/lazarus-logo.svg", type: "image/svg+xml" },
      { url: "/lazarus-icon-1024.png", type: "image/png", sizes: "1024x1024" },
    ],
    apple: "/lazarus-icon-1024.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#14101c",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${cinzel.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: STILL_INIT_SCRIPT }} />
      </head>
      <body className="relative flex min-h-full flex-col bg-background text-text">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-candle focus:px-4 focus:py-2 focus:font-medium focus:text-background"
        >
          Skip to content
        </a>
        <Atmosphere />
        <GhostCursor />
        <header className="relative z-10 border-b border-border">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
            <Link href="/" className="-ml-1 flex items-center gap-2 rounded-md hover:text-candle focus-visible:outline-2 focus-visible:outline-candle" aria-label="Lazarus, home">
              <LazarusMark size={48} variant="plain" className="shrink-0" />
              <span className="relative z-10 font-display text-3xl tracking-wide text-text">
                Lazarus
              </span>
            </Link>
            <StillToggle />
          </div>
        </header>
        <main
          id="main-content"
          className="fade-in relative z-10 mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6"
        >
          {children}
        </main>
        <footer className="relative z-10 border-t border-border">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-sm text-muted sm:px-6">
            <a
              href="https://github.com/devops-den/lazarus"
              className="underline underline-offset-4 hover:text-candle"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <span>Built with Kiro</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
