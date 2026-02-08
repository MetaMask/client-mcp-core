import { describe, it, expect } from 'vitest';
import type {
  IPlatformDriver,
  PlatformType,
  TargetType,
  ClickActionResult,
  TypeActionResult,
  PlatformScreenshotOptions,
} from './types.js';

describe('Platform Types', () => {
  it('should define IPlatformDriver interface', () => {
    // Type-level verification - if this compiles, the types are correctly defined
    const platformTypes: PlatformType[] = ['browser', 'ios'];
    expect(platformTypes).toHaveLength(2);
  });

  it('should define TargetType', () => {
    const targets: TargetType[] = ['a11yRef', 'testId', 'selector'];
    expect(targets).toHaveLength(3);
  });

  it('should define action result types', () => {
    const clickResult: ClickActionResult = { clicked: true, target: 'testId:foo' };
    expect(clickResult.clicked).toBe(true);

    const typeResult: TypeActionResult = {
      typed: true,
      target: 'testId:bar',
      textLength: 5,
    };
    expect(typeResult.typed).toBe(true);
  });

  it('should define screenshot options', () => {
    const options: PlatformScreenshotOptions = { name: 'test' };
    expect(options.name).toBe('test');
  });
});
