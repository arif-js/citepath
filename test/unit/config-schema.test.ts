import { describe, expect, it } from 'vitest';
import { buildJsonSchema } from '../../src/config/schema.js';

describe('Published JSON Schema', () => {
  it('matches the zod config schema (run `npm run schema:update` after changing it)', async () => {
    const expected = `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
    await expect(expected).toMatchFileSnapshot('../../schema/citepath.schema.json');
  });
});
