import type { Metadata } from "next";
import Image from "next/image";
import { Cinzel, Inter, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Lazarus — dead SOAP services, reborn as MCP tools",
  description:
    "Paste a WSDL URL and Lazarus raises the legacy SOAP service as a live MCP server that any AI agent can call.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="relative flex min-h-full flex-col bg-background text-text">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-candle focus:px-4 focus:py-2 focus:font-medium focus:text-background"
        >
          Skip to content
        </a>
        <div className="spirit-mist" aria-hidden="true" />
        <header className="relative z-10 border-b border-border">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
            <Image
              src="/lazarus-logo.svg"
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 shrink-0"
            />
            <span className="font-display text-xl tracking-wide text-text">
              Lazarus
            </span>
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
