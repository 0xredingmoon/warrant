/**
 * Encodes the recorded screencast frames into the demo video. Separate from the recorder so the timing can be tuned
 * without another live run:  FRAMES=/tmp/warrant-frames OUT=/workspace/warrant-media tsx src/encode.ts
 *
 * Waits for the chain play sped up, and never longer than MAX_WAIT seconds on screen however slow the RPC was.
 * Waits less than MERGE_GAP ms apart count as one (a flow of several transactions).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const SPEEDUP = 3.5;
export const MAX_WAIT = 4.5;
const MERGE_GAP = 3000;

export interface Recording {
  frames: { file: string; t: number }[];
  waits: [number, number][];
  end: number;
}

export function encode(rec: Recording, framesDir: string, outFile: string) {
  const { frames, end } = rec;
  const waits: [number, number][] = [];
  for (const w of [...rec.waits].sort((a, b) => a[0] - b[0])) {
    const last = waits.at(-1);
    if (last && w[0] - last[1] < MERGE_GAP) last[1] = Math.max(last[1], w[1]);
    else waits.push([w[0], w[1]]);
  }
  const list: string[] = [];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? end;
    const span = waits.find(([a, b]) => f.t >= a && f.t < b);
    const factor = span ? Math.min(1 / SPEEDUP, MAX_WAIT / Math.max(0.001, (span[1] - span[0]) / 1000)) : 1;
    list.push(`file '${f.file}'`, `duration ${Math.max(0.01, ((next - f.t) / 1000) * factor).toFixed(3)}`);
  });
  list.push(`file '${frames.at(-1)!.file}'`);
  const total = frames.reduce((t, f, i) => {
    const next = frames[i + 1]?.t ?? end;
    const span = waits.find(([a, b]) => f.t >= a && f.t < b);
    const factor = span ? Math.min(1 / SPEEDUP, MAX_WAIT / Math.max(0.001, (span[1] - span[0]) / 1000)) : 1;
    return t + Math.max(0.01, ((next - f.t) / 1000) * factor);
  }, 0);
  writeFileSync(`${framesDir}/list.txt`, list.join("\n"));
  const vf = "scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf2efe7,fps=30,format=yuv420p";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${framesDir}/list.txt`, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-movflags", "+faststart", "-an", "-t", total.toFixed(3), outFile], { stdio: "inherit" });
  const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outFile]).toString().trim();
  console.log(`video ${outFile}  ${Number(dur).toFixed(1)}s`);
}

if (process.argv[1]?.endsWith("encode.ts")) {
  const dir = process.env.FRAMES ?? "/tmp/warrant-frames";
  const out = process.env.OUT ?? "/workspace/warrant-media";
  encode(JSON.parse(readFileSync(`${dir}/frames.json`, "utf8")), dir, `${out}/${process.env.FILE ?? "demo.mp4"}`);
}
