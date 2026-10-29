const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAiCodexLogDetector } = require('../dist/codex-log-detector.js');

function createHarness() {
  let now = 50000;
  let scheduled;
  const completions = [];
  const detector = new OpenAiCodexLogDetector(
    (source) => completions.push(source),
    {
      quietMs: 100,
      now: () => now,
      setTimer(callback) {
        scheduled = callback;
        return callback;
      },
      clearTimer(timer) {
        if (scheduled === timer) {
          scheduled = undefined;
        }
      }
    }
  );

  return {
    detector,
    completions,
    advance(milliseconds) {
      now += milliseconds;
    },
    runTimer() {
      assert.equal(typeof scheduled, 'function', 'expected a quiet-period timer');
      const callback = scheduled;
      scheduled = undefined;
      callback();
    },
    hasTimer() {
      return scheduled !== undefined;
    }
  };
}

test('detects the current Codex turn-start/read-state completion sequence', () => {
  const harness = createHarness();
  harness.detector.inspect(
    '2026-08-03 [info] Reasoning summary turn-start config resolved conversationId=thread-1',
    'chatHeuristic'
  );
  harness.advance(1000);
  harness.detector.inspect(
    '2026-08-03 [info] Reasoning summary item completed turnId=turn-1',
    'chatHeuristic'
  );
  harness.advance(10000);
  harness.detector.inspect(
    '2026-08-03 [warning] Received broadcast method=thread-read-state-changed',
    'chatHeuristic'
  );

  assert.equal(harness.hasTimer(), true);
  harness.advance(100);
  harness.runTimer();
  assert.deepEqual(harness.completions, ['OpenAI Codex turn completed']);
});

test('keeps compatibility with the legacy stream/read-state sequence', () => {
  const harness = createHarness();
  const streamLines = Array.from(
    { length: 6 },
    () => '2026-07-01 [warning] Received broadcast method=thread-stream-state-changed'
  ).join('\n');
  harness.detector.inspect(streamLines, 'chatHeuristic');
  harness.detector.inspect(
    '2026-07-01 [warning] Received broadcast method=thread-read-state-changed',
    'chatHeuristic'
  );

  harness.advance(100);
  harness.runTimer();
  assert.deepEqual(harness.completions, ['OpenAI Codex chat stream settled']);
});

test('does not treat an unrelated read-state event as a completion', () => {
  const harness = createHarness();
  harness.detector.inspect(
    '2026-08-03 [warning] Received broadcast method=thread-read-state-changed',
    'chatHeuristic'
  );

  assert.equal(harness.hasTimer(), false);
  assert.deepEqual(harness.completions, []);
});

test('conservative mode accepts only the strong turn-diff marker', () => {
  const harness = createHarness();
  harness.detector.inspect(
    [
      'Reasoning summary turn-start config resolved conversationId=thread-1',
      'Received broadcast method=thread-read-state-changed'
    ].join('\n'),
    'conservative'
  );
  assert.deepEqual(harness.completions, []);

  harness.detector.inspect(
    '[git] git.command.complete requestKind=turn-diff-capture-complete status=completed',
    'conservative'
  );
  assert.deepEqual(harness.completions, ['OpenAI Codex turn diff completed']);
});

test('a strong marker cancels a pending heuristic completion', () => {
  const harness = createHarness();
  harness.detector.inspect(
    [
      'Reasoning summary turn-start config resolved conversationId=thread-1',
      'Received broadcast method=thread-read-state-changed'
    ].join('\n'),
    'chatHeuristic'
  );
  assert.equal(harness.hasTimer(), true);

  harness.detector.inspect(
    '[git] git.command.complete requestKind=turn-diff-capture-complete status=completed',
    'chatHeuristic'
  );
  assert.equal(harness.hasTimer(), false);
  assert.deepEqual(harness.completions, ['OpenAI Codex turn diff completed']);
});
