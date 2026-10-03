// 极简测试框架：无依赖，node test/run.js 运行（顶层 await 收集异步用例）。
let passed = 0;
let failed = 0;
let failures = [];
let stack = [];
const pending = [];

export function describe(name, fn) {
  stack.push(name);
  fn();
  stack.pop();
}

export function it(name, fn) {
  const label = [...stack, name].join(' > ');
  const run = () => {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        return r.then(
          () => {
            passed++;
          },
          (e) => {
            failed++;
            failures.push({ label, e });
          }
        );
      }
      passed++;
    } catch (e) {
      failed++;
      failures.push({ label, e });
    }
  };
  pending.push(run);
}

export async function flush() {
  for (const run of pending) await run();
}

export function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

export function ok(v, msg = '') {
  if (!v) throw new Error(msg || `expected truthy, got ${JSON.stringify(v)}`);
}

export function notOk(v, msg = '') {
  if (v) throw new Error(msg || `expected falsy, got ${JSON.stringify(v)}`);
}

export function report() {
  for (const { label, e } of failures) {
    console.error(`✗ ${label}`);
    console.error(`    ${e.message.replace(/\n/g, '\n    ')}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}
