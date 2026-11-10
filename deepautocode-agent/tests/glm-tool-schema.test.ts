import { describe, expect, it } from 'vitest';
import {
  trimToolDescriptionForGlm,
  trimToolJsonSchemaForGlm,
} from '../src/core/GlmToolSchema.js';

describe('GlmToolSchema', () => {
  it('trims long tool and property descriptions', () => {
    const long = 'A'.repeat(200);
    expect(trimToolDescriptionForGlm(long).length).toBeLessThanOrEqual(96);
    const schema = trimToolJsonSchemaForGlm({
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path '.repeat(20),
        },
      },
    });
    const fp = (schema.properties as any)?.filePath;
    expect(String(fp?.description || '').length).toBeLessThanOrEqual(44);
  });
});
