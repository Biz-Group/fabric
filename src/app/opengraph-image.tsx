import { ImageResponse } from "next/og";

export const alt = "Fabric — Turn how work really happens into a living map of your business";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#f7f5f0",
        color: "#11161c",
        padding: "64px 72px",
        flexDirection: "column",
        justifyContent: "space-between",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 78,
          right: 82,
          display: "flex",
          width: 430,
          height: 430,
          border: "1px solid #c8cdc2",
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 135,
          right: 139,
          display: "flex",
          width: 316,
          height: 316,
          border: "1px solid #c8cdc2",
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 242,
          right: 246,
          display: "flex",
          width: 102,
          height: 102,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          background: "#11161c",
          color: "#fffefb",
          fontSize: 30,
          fontWeight: 700,
        }}
      >
        F.
      </div>
      <div style={{ display: "flex", fontSize: 34, fontWeight: 700 }}>
        Fabric.
      </div>
      <div
        style={{
          display: "flex",
          width: 760,
          flexDirection: "column",
          fontSize: 70,
          fontWeight: 650,
          letterSpacing: "-4px",
          lineHeight: 0.98,
        }}
      >
        See how your business really works.
      </div>
      <div
        style={{
          display: "flex",
          width: 640,
          color: "#62665f",
          fontSize: 24,
          lineHeight: 1.35,
        }}
      >
        Conversations become living process knowledge, clear maps, and better
        transformation decisions.
      </div>
    </div>,
    size,
  );
}
