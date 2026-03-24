type CounterKey =
  | "turn_requests_total"
  | "turn_success_total"
  | "turn_rewrite_total"
  | "turn_fail_total"
  | "proactive_attempts_total"
  | "proactive_fired_total"
  | "proactive_skip_tts_busy_total"
  | "proactive_skip_cooldown_total"
  | "proactive_skip_no_trends_total"
  | "proactive_skip_stale_total";

const counters: Record<CounterKey, number> = {
  turn_requests_total: 0,
  turn_success_total: 0,
  turn_rewrite_total: 0,
  turn_fail_total: 0,
  proactive_attempts_total: 0,
  proactive_fired_total: 0,
  proactive_skip_tts_busy_total: 0,
  proactive_skip_cooldown_total: 0,
  proactive_skip_no_trends_total: 0,
  proactive_skip_stale_total: 0,
};

export function incCounter(key: CounterKey): void {
  counters[key] += 1;
}

export function getMetricsSnapshot(): Record<CounterKey, number> {
  return { ...counters };
}
