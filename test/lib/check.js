/*
 * Shared pass/fail tally, used by every test file, so the combined run still
 * ends on one summary line, "N passed, M failed", the same shape the single
 * pre-split test file printed.
 */
let failed = 0;
let passed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log('pass ' + name); return; }
  failed++;
  console.log('FAIL ' + name + '\n  got:  ' + JSON.stringify(actual) + '\n  want: ' + JSON.stringify(expected));
}

// The bundle tests assert on a condition plus a detail string to print when it
// fails, rather than comparing two values, so they use this instead of check.
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('pass ' + name); return; }
  failed++;
  console.log('FAIL ' + name + (detail ? '\n  ' + detail : ''));
}

function counts() {
  return { passed, failed };
}

module.exports = { check, ok, counts };
