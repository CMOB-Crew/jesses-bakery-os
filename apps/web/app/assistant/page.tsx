import AskBar from "@/components/AskBar";

export const metadata = { title: "Assistant · Jesse's Bakery OS" };

export default function AssistantPage() {
  return (
    <>
      <div className="head"><h1>Assistant</h1></div>
      <div style={{ maxWidth: 720 }}>
        <p style={{ color: "var(--ink2)", marginBottom: 16, lineHeight: 1.6 }}>
          Ask anything about your stores — waste, stockouts, sales, regions, or which stores need
          attention. Every answer comes from a direct query over your live data, so the numbers are
          exact, never guessed.
        </p>
        <AskBar />
      </div>
    </>
  );
}
