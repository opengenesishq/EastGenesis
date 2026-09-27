import { stat } from "node:fs/promises";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";

const file = process.argv[2] ?? "out/eastgenesis-website-demo.mp4";
const input = new Input({
  formats: ALL_FORMATS,
  source: new FilePathSource(file),
});

try {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No primary video track found");

  const duration = await input.computeDuration();
  const { size } = await stat(file);
  const result = {
    file,
    bytes: size,
    width: track.displayWidth,
    height: track.displayHeight,
    durationSeconds: Number(duration.toFixed(4)),
    codec: track.codec,
  };

  if (result.width !== 1920 || result.height !== 1080) {
    throw new Error(`Expected 1920x1080, got ${result.width}x${result.height}`);
  }
  if (duration < 29.9 || duration > 30.2) {
    throw new Error(`Expected approximately 30 seconds, got ${duration}`);
  }
  if (result.codec !== "avc") {
    throw new Error(`Expected H.264/AVC, got ${result.codec}`);
  }

  console.log(JSON.stringify(result, null, 2));
} finally {
  await input.dispose();
}
