export const metadata = { title: "Hype MCP — marketing agent", description: "Research a brand, create posts and reels, benchmark them." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0b0b0f", color: "#f2f2f5" }}>{children}</body>
    </html>
  );
}
