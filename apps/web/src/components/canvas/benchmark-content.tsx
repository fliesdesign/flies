import type { CanvasFrame } from "@flies/canvas";
import { memo } from "react";

const THUMBNAIL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" fill="#e9e6e0"/><circle cx="115" cy="28" r="13" fill="#e6b98b"/><path d="M0 100V75L48 27l43 44 27-30 42 42v17Z" fill="#759084"/><path d="m0 100 58-39 30 23 21-16 51 32Z" fill="#345d50"/></svg>',
)}`;

const TEAMS = ["Product studio", "Design systems", "Research team"];
const TRACKS = ["Design", "Prototype", "Review"];

/** Rich, noninteractive DOM used only by the explicitly enabled benchmark scene. */
export const BenchmarkFrameContent = memo(function BenchmarkFrameContent({
  frame,
}: {
  frame: CanvasFrame;
}) {
  const index = Number(frame.id.slice("bench-".length)) || 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 24,
        height: "100%",
        overflow: "hidden",
        color: "#202820",
        background: index % 3 === 0 ? "#f7f8f3" : "#ffffff",
        fontFamily: "Arial, sans-serif",
        fontSize: 12,
        lineHeight: "16px",
        textAlign: "left",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700 }}>{TEAMS[index % TEAMS.length]}</span>
        <span style={{ color: "#69776d", fontSize: 10 }}>PROJECT {index + 1}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 112px", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 22, lineHeight: "26px", fontWeight: 700 }}>
            A little room to explore.
          </span>
          <span style={{ color: "#69776d" }}>
            Ideas, details, and a shared direction for the next release.
          </span>
        </div>
        <img
          src={THUMBNAIL}
          alt=""
          width={112}
          height={96}
          decoding="async"
          style={{ objectFit: "cover", borderRadius: 8 }}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {TRACKS.map((track, position) => (
          <div
            key={track}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 10,
              border: "1px solid #e3e8e0",
              borderRadius: 8,
            }}
          >
            <span style={{ color: "#69776d", fontSize: 10 }}>{track}</span>
            <span style={{ fontWeight: 700 }}>{12 + ((index + position * 7) % 36)} tasks</span>
            <div style={{ height: 3, background: "#e3e8e0", borderRadius: 2 }}>
              <div
                style={{
                  width: `${30 + ((index + position * 13) % 65)}%`,
                  height: "100%",
                  background: "#759084",
                  borderRadius: 2,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
