import { personName, tidyName } from './person-name.js';

describe('person names', () => {
  it('keeps one space between words and none at the ends, in any script', () => {
    expect(tidyName('  Neha   Gupta ')).toBe('Neha Gupta');
    expect(tidyName('प्रिया\t वर्मा')).toBe('प्रिया वर्मा');
    expect(tidyName('Single')).toBe('Single');
  });
  it('checks the length after tidying, so spaces cannot make a name look long or fill a short one', () => {
    const schema = personName(2, 10);
    expect(schema.safeParse('  A   B  ').success).toBe(true);
    expect(schema.safeParse('   A   ').success).toBe(false);
    expect(schema.safeParse('Abcdefgh   Ij').success).toBe(false);
  });
});
