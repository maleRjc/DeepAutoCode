/** Trim OpenAI tool definitions for GLM 128K — smaller KV cache + less prompt bloat. */

const MAX_TOOL_DESC = 96;
const MAX_PARAM_DESC = 44;

export function trimToolDescriptionForGlm(description: unknown): string {
  const s = String(description ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= MAX_TOOL_DESC) return s;
  const head = s.slice(0, MAX_TOOL_DESC - 1);
  return `${head.replace(/\s+\S*$/, '').trim()}…`;
}

export function trimToolJsonSchemaForGlm(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  let sch: Record<string, unknown>;
  try {
    sch = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch {
    return { type: 'object', properties: {} };
  }
  delete sch.$schema;
  if (typeof sch.description === 'string' && (sch.description as string).length > 60) {
    sch.description = `${(sch.description as string).slice(0, 58)}…`;
  }
  const props = sch.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const key of Object.keys(props as Record<string, unknown>)) {
      const p = (props as Record<string, unknown>)[key];
      if (p && typeof p === 'object' && p !== null) {
        const po = p as Record<string, unknown>;
        if (typeof po.description === 'string' && po.description.length > MAX_PARAM_DESC) {
          po.description = `${po.description.slice(0, MAX_PARAM_DESC - 1)}…`;
        }
      }
    }
  }
  return sch;
}

/** Extra shrink when context fill is high (compaction already running). */
export function trimToolDescriptionForGlmAggressive(description: unknown): string {
  const base = trimToolDescriptionForGlm(description);
  return base.length > 56 ? `${base.slice(0, 54)}…` : base;
}
