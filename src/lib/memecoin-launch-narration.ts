/**
 * Pre-written narration templates for the launch sequence.
 * Qwen is too slow (~45-60s) for live generation during a countdown,
 * so we use templates with variable interpolation.
 */

type NarrationVars = {
  name: string;
  ticker: string;
  tagline: string;
  trend: string;
  score: string;
  mint: string;
  error: string;
};

function interpolate(template: string, vars: Partial<NarrationVars>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value ?? "");
  }
  // Fix pronunciation for TTS
  return result.replace(/memecoin/gi, "meemcoin");
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SELECTING = [
  "I've been analyzing these trends and I think {name}, ticker {ticker}, has the strongest potential. Viability score: {score} out of 100.",
  "After running the numbers, {name} stands out. It's riding the {trend} wave with a {score} viability score. Let's make this happen.",
  "The analysis is clear. {name}, ticker {ticker}, is our best shot. {tagline}. Preparing for launch.",
];

const COUNTDOWN_START = [
  "Initiating launch sequence for {name}. Deploying to pump dot fun in 10 seconds.",
  "Launch sequence activated. {name} goes live in 10 seconds. Here we go.",
];

const COUNTDOWN_5 = "5 seconds.";
const COUNTDOWN_3 = "3... 2... 1...";

const LAUNCHING = [
  "Launching {name} on pump dot fun right now!",
  "Deploying {name} to the blockchain. This is it!",
];

const SUCCESS = [
  "{name} is live! Ticker {ticker} is now trading on pump dot fun. Welcome to the blockchain.",
  "It's done. {name}, ticker {ticker}, is officially on pump dot fun. The meemcoin has landed.",
];

const FAILED = [
  "Launch failed. We'll try again with the next batch of ideas.",
  "Something went wrong with the deployment. Don't worry, we'll try again soon.",
];

export function narrationSelecting(vars: Partial<NarrationVars>): string {
  return interpolate(pick(SELECTING), vars);
}

export function narrationCountdownStart(vars: Partial<NarrationVars>): string {
  return interpolate(pick(COUNTDOWN_START), vars);
}

export function narrationCountdown5(): string {
  return COUNTDOWN_5;
}

export function narrationCountdown3(): string {
  return COUNTDOWN_3;
}

export function narrationLaunching(vars: Partial<NarrationVars>): string {
  return interpolate(pick(LAUNCHING), vars);
}

export function narrationSuccess(vars: Partial<NarrationVars>): string {
  return interpolate(pick(SUCCESS), vars);
}

export function narrationFailed(vars: Partial<NarrationVars>): string {
  return interpolate(pick(FAILED), vars);
}
