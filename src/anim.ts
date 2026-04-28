import chalk from "chalk";

const SHIP = "⛵";
const WAVE = "~";

// Brand-ish palette
const claudeColor = chalk.hex("#FF8C42");  // Claude orange/peach
const codexColor = chalk.hex("#3B82F6");   // Codex blue

function colorFor(label: string) {
  const lower = label.toLowerCase();
  if (lower.includes("claude")) return claudeColor;
  if (lower.includes("codex")) return codexColor;
  return chalk.bold.white;
}

export interface FerryOptions {
  fromLabel?: string;
  toLabel?: string;
  durationMs?: number;
  width?: number;
}

/**
 * Animate a ferry crossing from `fromLabel` to `toLabel`. Resolves once the
 * ship docks. Falls back to a single static line if stdout isn't a TTY.
 */
export async function ferry(opts: FerryOptions = {}): Promise<void> {
  const fromLabel = opts.fromLabel ?? "Claude";
  const toLabel = opts.toLabel ?? "Codex";
  const duration = opts.durationMs ?? 500;
  const cols = process.stdout.columns ?? 80;
  const trackWidth = Math.max(20, Math.min(opts.width ?? 50, cols - fromLabel.length - toLabel.length - 8));
  const frames = 24;

  const fromColor = colorFor(fromLabel);
  const toColor = colorFor(toLabel);

  const isTTY = process.stdout.isTTY;
  if (!isTTY) {
    process.stdout.write(`${chalk.dim(fromLabel)}  ${SHIP}  ${chalk.dim(toLabel)}\n`);
    return;
  }

  process.stdout.write("\x1b[?25l"); // hide cursor

  for (let i = 0; i <= frames; i++) {
    const pos = Math.round((i / frames) * (trackWidth - 1));
    // Wake: water behind the ship is tinted with the source color (where it
    // came from); water ahead stays the destination color. As the ship moves,
    // the trail of "from" color grows and the "to" color shrinks.
    const wake = fromColor.dim(WAVE.repeat(pos));
    const ahead = toColor.dim(WAVE.repeat(trackWidth - pos - 1));
    const line =
      ` ${chalk.bold(fromColor(fromLabel))} ` +
      wake +
      chalk.bold.white(SHIP) +
      ahead +
      ` ${chalk.bold(toColor(toLabel))} `;
    process.stdout.write("\r\x1b[K" + line);
    await sleep(duration / frames);
  }

  // Docked: full wake in source color, ship at the destination edge
  for (const ch of [SHIP, " " + SHIP]) {
    process.stdout.write(
      "\r\x1b[K" +
        ` ${chalk.bold(fromColor(fromLabel))} ` +
        fromColor.dim(WAVE.repeat(trackWidth - 1)) +
        chalk.bold.white(ch) +
        ` ${chalk.bold(toColor(toLabel))} `,
    );
    await sleep(40);
  }

  process.stdout.write("\n");
  process.stdout.write("\x1b[?25h"); // show cursor
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Restore cursor on Ctrl-C even mid-animation.
process.on("SIGINT", () => {
  process.stdout.write("\x1b[?25h\n");
  process.exit(130);
});
