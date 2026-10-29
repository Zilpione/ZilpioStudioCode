const { test } = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../../extensions/zilpio-codex/media/official-usage.js');

test('reports remaining quota and selects windows by their duration', () => {
	const result = usage.windows({ rateLimits: { primary: { usedPercent: 84, windowDurationMins: 10080 }, secondary: { usedPercent: 20, windowDurationMins: 300 } } });
	assert.equal(result.fiveHours.remaining, 80);
	assert.equal(result.week.remaining, 16);
	assert.equal(result.week.color, 'red');
});
test('prefers the core Codex bucket and never treats missing usage as full quota', () => {
	const result = usage.windows({ rateLimitsByLimitId: { codex: { primary: { usedPercent: null, windowDurationMins: 300 } } }, rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } });
	assert.equal(result.fiveHours, null);
	assert.equal(result.week, null);
});
test('clamps usage and ignores unrelated window sizes', () => {
	assert.equal(usage.windows({ primary: { usedPercent: 120, windowDurationMins: 300 } }).fiveHours.remaining, 0);
	assert.equal(usage.windows({ primary: { usedPercent: -10, windowDurationMins: 10080 } }).week.remaining, 100);
	assert.equal(usage.windows({ primary: { usedPercent: 20, windowDurationMins: 60 } }).fiveHours, null);
});
test('formats reset time locally and distinguishes a later reset date', () => {
	const now = new Date(2026, 9, 13, 8, 0);
	assert.equal(usage.resetLabel(new Date(2026, 9, 13, 14, 30).getTime() / 1000, now), 'reset alle 14:30');
	assert.equal(usage.resetLabel(new Date(2026, 9, 19, 9, 5).getTime() / 1000, now), 'reset alle 09:05 (19/10)');
	assert.equal(usage.resetLabel(null, now), 'reset non disponibile');
});
