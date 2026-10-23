/** Contadores em memória no formato de texto do Prometheus (GET /metrics). Por instância. */
export class Metrics {
  private readonly counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>();

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}|${JSON.stringify(Object.entries(labels).sort())}`;
    const current = this.counters.get(key);
    if (current) current.value += by;
    else this.counters.set(key, { name, labels, value: by });
  }

  render(): string {
    const lines: string[] = [];
    const typed = new Set<string>();
    for (const { name, labels, value } of this.counters.values()) {
      if (!typed.has(name)) {
        lines.push(`# TYPE ${name} counter`);
        typed.add(name);
      }
      const rendered = Object.entries(labels)
        .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(',');
      lines.push(`${name}${rendered ? `{${rendered}}` : ''} ${value}`);
    }
    return lines.join('\n') + '\n';
  }
}
