/** Terminal presentation for the interactive commands.
 *
 * Written by hand rather than pulled in: this package installs into an
 * environment that also holds a token to someone's entire financial history,
 * and a prompt library is a dependency tree to audit for the sake of eight
 * escape codes. Everything here is those eight codes and a timer.
 *
 * Every function degrades to plain text. Setup output gets piped into files
 * and issue reports, and a log full of `[36m` is worse than one with no
 * colour at all.
 */

/** Whether to emit colour, decided once.
 *
 * `NO_COLOR` is honoured because it is the convention every other tool
 * honours, and `FORCE_COLOR` because CI logs are not TTYs but people still
 * want to read them in colour.
 */
function colourEnabled(): boolean {
  const env = process.env;
  if ((env.NO_COLOR ?? "") !== "") return false;
  if ((env.FORCE_COLOR ?? "") !== "") return true;
  if (env.TERM === "dumb") return false;
  return process.stdout.isTTY === true;
}

const COLOUR = colourEnabled();

function wrap(open: string, text: string): string {
  return COLOUR ? `\u001b[${open}m${text}\u001b[0m` : text;
}

export const bold = (text: string): string => wrap("1", text);
export const dim = (text: string): string => wrap("2", text);
export const red = (text: string): string => wrap("31", text);
export const green = (text: string): string => wrap("32", text);
export const yellow = (text: string): string => wrap("33", text);
export const cyan = (text: string): string => wrap("36", text);

/** A tick and a cross a terminal without UTF-8 can still print.
 *
 * Not gated on colour: a monochrome terminal still renders these, and a
 * redirected file keeps them as characters rather than as escape sequences. */
const UNICODE = process.platform !== "win32" || (process.env.WT_SESSION ?? "") !== "";
export const TICK = UNICODE ? "✓" : "+";
export const CROSS = UNICODE ? "✗" : "x";

export function heading(title: string, lines: string[] = []): void {
  process.stdout.write(`\n  ${bold(title)}\n`);
  process.stdout.write(`  ${dim("─".repeat(Math.max(title.length, 44)))}\n`);
  for (const line of lines) process.stdout.write(`  ${dim(line)}\n`);
  process.stdout.write("\n");
}

/** `Step 2 of 3  Personal Access Token` — the count is the reassurance: it
 * says how much is left, which a bare question does not. */
export function step(index: number, total: number, label: string): void {
  process.stdout.write(`\n  ${cyan(`Step ${index} of ${total}`)}  ${bold(label)}\n`);
}

export const ok = (text: string): void => void process.stdout.write(`  ${green(TICK)} ${text}\n`);
export const bad = (text: string): void => void process.stdout.write(`  ${red(CROSS)} ${text}\n`);
export const note = (text: string): void => void process.stdout.write(`  ${dim(text)}\n`);
export const warn = (text: string): void => void process.stdout.write(`  ${yellow("!")} ${text}\n`);

export type Spinner = {
  succeed: (text: string) => void;
  fail: (text: string) => void;
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A spinner while something waits on the network.
 *
 * Off a TTY it prints the label once and the outcome when it arrives: writing
 * a frame every eighty milliseconds into a file that nobody is watching
 * animate produces thousands of lines of nothing.
 */
export function spinner(label: string): Spinner {
  if (!COLOUR || process.stdout.isTTY !== true) {
    process.stdout.write(`  ${label}\n`);
    return {
      succeed: (text) => ok(text),
      fail: (text) => bad(text),
    };
  }

  let frame = 0;
  const draw = (): void => {
    process.stdout.write(`\r  ${cyan(FRAMES[frame % FRAMES.length]!)} ${label}`);
    frame += 1;
  };
  draw();
  const timer = setInterval(draw, 80);
  // Unref'd so a spinner someone forgot to stop cannot hold the process open.
  timer.unref();

  const finish = (render: (text: string) => void, text: string): void => {
    clearInterval(timer);
    // Wipe the line rather than overwrite it: the outcome is often shorter
    // than the label, and the tail of the label would otherwise survive.
    process.stdout.write(`\r${" ".repeat(label.length + 6)}\r`);
    render(text);
  };

  return {
    succeed: (text) => finish(ok, text),
    fail: (text) => finish(bad, text),
  };
}
