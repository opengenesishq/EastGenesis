import React from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

type SceneId = "provider" | "task" | "failover" | "diff" | "outro";

type SceneData = {
  id: SceneId;
  from: number;
  duration: number;
  step: string;
  title: string;
  description: string;
  accent: string;
  asset?: string;
};

const SCENES: SceneData[] = [
  {
    id: "provider",
    from: 0,
    duration: 6 * FPS,
    step: "01 / PROVIDER",
    title: "先把 Provider 配好",
    description: "自带 Key，连接你已经在用的模型服务。",
    accent: "#7dd3fc",
    asset: "provider-settings.png",
  },
  {
    id: "task",
    from: 6 * FPS,
    duration: 7 * FPS,
    step: "02 / TASK",
    title: "把任务交给工作台",
    description: "项目、会话、工具和上下文在同一个工作面里。",
    accent: "#a7f3d0",
    asset: "session.png",
  },
  {
    id: "failover",
    from: 13 * FPS,
    duration: 7 * FPS,
    step: "03 / FAILOVER",
    title: "Key 失败，自动接管",
    description: "同一 Provider 的备用 Key 接续请求，不丢任务。",
    accent: "#fcd34d",
    asset: "failover.png",
  },
  {
    id: "diff",
    from: 20 * FPS,
    duration: 7 * FPS,
    step: "04 / REVIEW",
    title: "先看 Diff，再交付",
    description: "隔离工作区让每一次修改都可检查、可应用、可回退。",
    accent: "#c4b5fd",
    asset: "diff.png",
  },
  {
    id: "outro",
    from: 27 * FPS,
    duration: 3 * FPS,
    step: "EASTGENESIS / 30 SEC",
    title: "你的 AI 工作桌面",
    description: "OpenAI-compatible + 原生 Anthropic Messages · BYOK",
    accent: "#fb923c",
  },
];

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const easeIn = Easing.bezier(0.7, 0, 0.84, 0);

const fadeForScene = (frame: number, duration: number) => {
  const fadeIn = interpolate(frame, [0, 18], [0, 1], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(frame, [duration - 18, duration], [1, 0], {
    easing: easeIn,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return Math.min(fadeIn, fadeOut);
};

const SceneHeader: React.FC<{ scene: SceneData; opacity: number; offset: number }> = ({
  scene,
  opacity,
  offset,
}) => (
  <div
    style={{
      position: "absolute",
      left: 100,
      top: 112 + offset,
      width: 560,
      opacity,
      fontFamily: FONT_FAMILY,
    }}
  >
    <div
      style={{
        color: scene.accent,
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: 0,
        lineHeight: 1.2,
      }}
    >
      {scene.step}
    </div>
    <div
      style={{
        marginTop: 14,
        color: "#f8fafc",
        fontSize: 44,
        fontWeight: 760,
        letterSpacing: 0,
        lineHeight: 1.15,
        whiteSpace: "nowrap",
      }}
    >
      {scene.title}
    </div>
    <div
      style={{
        marginTop: 18,
        color: "#a5adbb",
        fontSize: 21,
        fontWeight: 450,
        letterSpacing: 0,
        lineHeight: 1.45,
        maxWidth: 520,
      }}
    >
      {scene.description}
    </div>
  </div>
);

const ScreenFrame: React.FC<{ scene: SceneData; opacity: number; offset: number }> = ({
  scene,
  opacity,
  offset,
}) => {
  if (!scene.asset) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 380,
        top: 276 + offset,
        width: 1440,
        height: 730,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: 22,
        backgroundColor: "#090b0e",
        boxShadow: "0 30px 90px rgba(0,0,0,0.5)",
        opacity,
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 2,
          top: 0,
          left: 0,
          right: 0,
          height: 42,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 16px",
          backgroundColor: "#111419",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: 9, backgroundColor: "#ff5f57" }} />
        <span style={{ width: 9, height: 9, borderRadius: 9, backgroundColor: "#febc2e" }} />
        <span style={{ width: 9, height: 9, borderRadius: 9, backgroundColor: "#28c840" }} />
        <span
          style={{
            marginLeft: 12,
            color: "#647184",
            fontFamily: FONT_FAMILY,
            fontSize: 12,
            letterSpacing: 0,
          }}
        >
          EastGenesis · live product evidence
        </span>
      </div>
      <Img
        src={staticFile(`screenshots/${scene.asset}`)}
        style={{
          position: "absolute",
          left: 0,
          top: 42,
          width: "100%",
          height: "calc(100% - 42px)",
          objectFit: "cover",
          objectPosition: "center",
        }}
      />
      {scene.id === "provider" ? (
        <>
          <div
            style={{
              position: "absolute",
              left: 382,
              top: 245,
              zIndex: 3,
              color: "#98a2b3",
              fontFamily: FONT_FAMILY,
              fontSize: 13,
              fontWeight: 650,
              letterSpacing: 3,
            }}
          >
            ••••••••••••••
          </div>
          <div
            style={{
              position: "absolute",
              right: 28,
              top: 88,
              zIndex: 3,
              padding: "12px 16px",
              border: "1px solid rgba(125,211,252,0.38)",
              borderRadius: 12,
              backgroundColor: "rgba(7, 22, 31, 0.92)",
              color: "#d9f4ff",
              fontFamily: FONT_FAMILY,
              fontSize: 17,
              fontWeight: 650,
              letterSpacing: 0,
            }}
          >
            API Key 已加密保存
          </div>
        </>
      ) : null}
    </div>
  );
};

const Outro: React.FC<{ scene: SceneData; opacity: number; offset: number }> = ({
  scene,
  opacity,
  offset,
}) => (
  <AbsoluteFill
    style={{
      alignItems: "center",
      justifyContent: "center",
      opacity,
      transform: `translateY(${offset}px)`,
      fontFamily: FONT_FAMILY,
    }}
  >
    <Img
      src={staticFile("caogen-icon.png")}
      style={{ width: 106, height: 106, borderRadius: 25, boxShadow: "0 20px 50px rgba(251,146,60,0.22)" }}
    />
    <div
      style={{
        marginTop: 24,
        color: "#f8fafc",
        fontSize: 62,
        fontWeight: 760,
        letterSpacing: 0,
        lineHeight: 1,
      }}
    >
      EastGenesis
    </div>
    <div
      style={{
        marginTop: 20,
        color: "#cbd5e1",
        fontSize: 24,
        fontWeight: 520,
        letterSpacing: 0,
      }}
    >
      {scene.title}
    </div>
    <div
      style={{
        marginTop: 18,
        color: scene.accent,
        fontSize: 20,
        fontWeight: 650,
        letterSpacing: 0,
      }}
    >
      {scene.description}
    </div>
    <div
      style={{
        marginTop: 34,
        padding: "12px 22px",
        border: "1px solid rgba(251,146,60,0.45)",
        borderRadius: 999,
        color: "#fed7aa",
        fontSize: 19,
        fontWeight: 700,
        letterSpacing: 0,
      }}
    >
      EastGenesis Desktop · macOS Intel x64 preview
    </div>
  </AbsoluteFill>
);

const BrandBar: React.FC<{ frame: number }> = ({ frame }) => {
  const currentScene = SCENES.findIndex(
    (scene) => frame >= scene.from && frame < scene.from + scene.duration,
  );
  return (
    <div
      style={{
        position: "absolute",
        top: 36,
        left: 100,
        right: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontFamily: FONT_FAMILY,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <Img src={staticFile("caogen-icon.png")} style={{ width: 32, height: 32, borderRadius: 9 }} />
        <span style={{ color: "#f8fafc", fontSize: 19, fontWeight: 720, letterSpacing: 0 }}>EastGenesis</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {SCENES.map((scene, index) => (
          <div
            key={scene.id}
            style={{
              width: index === currentScene ? 42 : 18,
              height: 4,
              borderRadius: 4,
              backgroundColor: index <= currentScene ? scene.accent : "#2b3340",
              opacity: index === currentScene ? 1 : 0.72,
            }}
          />
        ))}
      </div>
    </div>
  );
};

const Scene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const opacity = fadeForScene(frame, scene.duration);
  const offset = interpolate(frame, [0, 24], [18, 0], {
    easing: easeOut,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      {scene.id === "outro" ? (
        <Outro scene={scene} opacity={opacity} offset={offset} />
      ) : (
        <>
          <SceneHeader scene={scene} opacity={opacity} offset={offset} />
          <ScreenFrame scene={scene} opacity={opacity} offset={offset} />
        </>
      )}
    </AbsoluteFill>
  );
};

export const DemoVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#080a0d",
        color: "#f8fafc",
        fontFamily: FONT_FAMILY,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          opacity: 0.38,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          backgroundColor: "#fb923c",
          opacity: 0.9,
        }}
      />
      {SCENES.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.from}
          durationInFrames={scene.duration}
          premountFor={fps}
          layout="absolute-fill"
        >
          <Scene scene={scene} />
        </Sequence>
      ))}
      <BrandBar frame={frame} />
      <div
        style={{
          position: "absolute",
          left: 100,
          bottom: 28,
          color: "#566273",
          fontSize: 13,
          fontWeight: 550,
          letterSpacing: 0,
        }}
      >
        Vendor-neutral · local-first · inspectable delivery
      </div>
    </AbsoluteFill>
  );
};

export const VideoComposition: React.FC = () => (
  <Composition
    id="EastGenesisWebsiteDemo"
    component={DemoVideo}
    durationInFrames={30 * FPS}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
