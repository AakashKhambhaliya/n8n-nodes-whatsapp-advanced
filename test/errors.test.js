'use strict';

/**
 * Phase 2b. The three traps in BUILD-PLAN section 2.5 each have a dedicated
 * assertion at the bottom of this file — they are the cases where getting it
 * wrong silently destroys paid-for messages.
 */

const { assert, suite, test, done, fakeNode } = require('./harness');

const {
	parseWaError,
	classifyWaError,
	dispositionOf,
	retryAfterMs,
	isMetaStatedWait,
	shouldFallbackToCloudApi,
	shouldFallbackToMarketingApi,
	isRetryable,
	isDeferred,
	explainWaError,
	toNodeError,
	backoffDelayMs,
} = require('../dist/nodes/WhatsAppAdvanced/helpers/errors');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How n8n's HTTP helper surfaces a Graph failure. */
const httpError = (code, details, extra = {}) => ({
	message: `Request failed with status code 400`,
	httpCode: '400',
	cause: {
		error: {
			message: `(#${code}) Something Meta said`,
			type: 'OAuthException',
			code,
			error_data: details ? { messaging_product: 'whatsapp', details } : undefined,
			fbtrace_id: 'AbCdEfGhIjK',
			...extra,
		},
	},
});

suite('errors.test.js — classification, disposition and fallback direction');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseWaError digs the envelope out of an n8n HTTP failure', () => {
	const parsed = parseWaError(httpError(131050, 'Message failed to send because the user opted out'));

	assert.strictEqual(parsed.code, 131050);
	assert.strictEqual(parsed.details, 'Message failed to send because the user opted out');
	assert.strictEqual(parsed.type, 'OAuthException');
	assert.strictEqual(parsed.fbtraceId, 'AbCdEfGhIjK');
	assert.strictEqual(parsed.httpStatus, 400);
});

test('parseWaError accepts the other shapes Meta arrives in', () => {
	assert.strictEqual(parseWaError({ error: { code: 131049 } }).code, 131049);
	assert.strictEqual(parseWaError({ response: { body: { error: { code: 190 } } } }).code, 190);
	assert.strictEqual(parseWaError({ response: { data: { error: { code: 368 } } } }).code, 368);
	// Flat webhook shape: title and href, no type or fbtrace_id.
	assert.strictEqual(
		parseWaError({ code: 131026, title: 'Receiver is incapable', href: 'https://x' }).href,
		'https://x',
	);
});

test('parseWaError never throws on something that is not a Meta error', () => {
	assert.strictEqual(parseWaError(new Error('socket hang up')).code, undefined);
	assert.strictEqual(parseWaError(undefined).message, 'Unknown WhatsApp API error');
	assert.strictEqual(parseWaError('a bare string').code, undefined);
	assert.strictEqual(parseWaError(null).code, undefined);
	assert.strictEqual(parseWaError(42).code, undefined);
});

test('re-parsing an error transport already annotated gives the same answer', () => {
	// transport attaches `waError` and rethrows the original, so the call site
	// parses an object that now holds both the raw envelope and a parsed one.
	const raw = httpError(131049, 'Per-user marketing cap reached');
	const once = parseWaError(raw);
	raw.waError = once;

	const twice = parseWaError(raw);

	assert.strictEqual(twice.code, once.code);
	assert.strictEqual(twice.details, once.details);
	assert.strictEqual(twice.fbtraceId, once.fbtraceId);
	assert.strictEqual(classifyWaError(twice), classifyWaError(once));
	assert.strictEqual(retryAfterMs(twice), retryAfterMs(once));
});

test('a circular error object does not hang the envelope search', () => {
	const circular = { message: 'boom' };
	circular.cause = circular;
	circular.error = { code: 132000 };

	assert.strictEqual(parseWaError(circular).code, 132000);
});

// ---------------------------------------------------------------------------
// The table in BUILD-PLAN section 7.2
// ---------------------------------------------------------------------------

const cases = [
	// [code, sentTo, class, disposition, toCloud, toMM]
	[131050, 'marketing_messages', 'opt_out', 'suppress', false, false],
	[130403, 'marketing_messages', 'undeliverable', 'suppress', false, false],
	[131026, 'messages', 'undeliverable', 'suppress', false, false],
	[131049, 'marketing_messages', 'deferred', 'retry_later', false, false],
	[131056, 'messages', 'deferred', 'retry_later', false, false],
	[131048, 'messages', 'deferred', 'retry_later', false, false],
	[131064, 'messages', 'deferred', 'retry_later', false, false],
	[4, 'messages', 'deferred', 'retry_later', false, false],
	[80007, 'messages', 'deferred', 'retry_later', false, false],
	[134101, 'marketing_messages', 'mm_fallback', 'reroute', true, false],
	[134102, 'marketing_messages', 'mm_fallback', 'reroute', true, false],
	[134100, 'marketing_messages', 'mm_fallback', 'reroute', true, false],
	[131055, 'marketing_messages', 'mm_fallback', 'reroute', true, false],
	[100, 'marketing_messages', 'mm_fallback', 'reroute', true, false],
	// Same code, other endpoint: "unsupported parameter" is not a routing signal.
	[100, 'messages', 'mm_fallback', 'reroute', false, false],
	[131063, 'messages', 'cloud_marketing_disabled', 'reroute', false, true],
	[130429, 'messages', 'retryable', 'retry_now', false, false],
	[131016, 'messages', 'retryable', 'retry_now', false, false],
	[132000, 'messages', 'template_mismatch', 'fix', false, false],
	[132012, 'messages', 'template_mismatch', 'fix', false, false],
	[131047, 'messages', 'fix_required', 'fix', false, false],
	[132016, 'messages', 'fix_required', 'fix', false, false],
	[190, 'messages', 'auth', 'fix', false, false],
	[368, 'messages', 'integrity', 'fix', false, false],
];

for (const [code, sentTo, expectedClass, expectedDisposition, toCloud, toMM] of cases) {
	test(`${code} sent to /${sentTo} → ${expectedClass} / ${expectedDisposition}`, () => {
		const parsed = parseWaError(httpError(code, 'details string'));
		const cls = classifyWaError(parsed);

		assert.strictEqual(cls, expectedClass);
		assert.strictEqual(dispositionOf(cls), expectedDisposition);
		assert.strictEqual(shouldFallbackToCloudApi(parsed, sentTo), toCloud);
		assert.strictEqual(shouldFallbackToMarketingApi(parsed, sentTo), toMM);
	});
}

test('an unrecognised code classifies as unknown rather than guessing', () => {
	const parsed = parseWaError(httpError(999999, 'brand new'));
	assert.strictEqual(classifyWaError(parsed), 'unknown');
	assert.strictEqual(dispositionOf('unknown'), 'unknown');
});

test('the 200–299 range is treated as authentication', () => {
	assert.strictEqual(classifyWaError(parseWaError(httpError(200))), 'auth');
	assert.strictEqual(classifyWaError(parseWaError(httpError(283))), 'auth');
});

// ---------------------------------------------------------------------------
// Retry hints
// ---------------------------------------------------------------------------

test('retryAfterMs returns exactly the two waits Meta states', () => {
	assert.strictEqual(retryAfterMs(parseWaError(httpError(131049))), 24 * HOUR);
	assert.strictEqual(retryAfterMs(parseWaError(httpError(134101))), 10 * MINUTE);

	assert.strictEqual(isMetaStatedWait(parseWaError(httpError(131049))), true);
	assert.strictEqual(isMetaStatedWait(parseWaError(httpError(134101))), true);
});

test('node-default waits are flagged as node defaults', () => {
	assert.strictEqual(retryAfterMs(parseWaError(httpError(131056))), 15 * MINUTE);
	assert.strictEqual(isMetaStatedWait(parseWaError(httpError(131056))), false);
	assert.strictEqual(retryAfterMs(parseWaError(httpError(131048))), 24 * HOUR);
	assert.strictEqual(isMetaStatedWait(parseWaError(httpError(131048))), false);
});

test('isRetryable and isDeferred separate "again now" from "again later"', () => {
	assert.strictEqual(isRetryable(parseWaError(httpError(130429))), true);
	assert.strictEqual(isRetryable(parseWaError(httpError(131049))), false);
	assert.strictEqual(isDeferred(parseWaError(httpError(131049))), true);
	assert.strictEqual(isDeferred(parseWaError(httpError(131050))), false);
});

test('backoffDelayMs grows and stays under the 8 s cap', () => {
	for (let attempt = 0; attempt < 8; attempt++) {
		const delay = backoffDelayMs(attempt);
		assert.ok(delay > 0 && delay <= 8000 * 1.25, `attempt ${attempt} gave ${delay}`);
	}
	assert.ok(backoffDelayMs(4) > backoffDelayMs(0));
});

// ---------------------------------------------------------------------------
// The three traps
// ---------------------------------------------------------------------------

test('trap 1: an opt-out never carries a retry hint', () => {
	const parsed = parseWaError(httpError(131050, 'user opted out'));

	assert.strictEqual(classifyWaError(parsed), 'opt_out');
	assert.strictEqual(retryAfterMs(parsed), undefined);
	assert.strictEqual(isDeferred(parsed), false);
});

test('trap 1b: a frequency cap is deferred, not a refusal', () => {
	const parsed = parseWaError(httpError(131049, 'per-user marketing cap'));

	assert.strictEqual(classifyWaError(parsed), 'deferred');
	assert.strictEqual(dispositionOf('deferred'), 'retry_later');
	assert.strictEqual(retryAfterMs(parsed), 24 * HOUR);
});

test('trap 2: 131050 is never replayed on either endpoint', () => {
	const parsed = parseWaError(httpError(131050));

	assert.strictEqual(shouldFallbackToCloudApi(parsed, 'marketing_messages'), false);
	assert.strictEqual(shouldFallbackToMarketingApi(parsed, 'messages'), false);
});

test('trap 3: 100 only reroutes when the request went to /marketing_messages', () => {
	const parsed = parseWaError(httpError(100, 'Message must be a template message'));

	assert.strictEqual(shouldFallbackToCloudApi(parsed, 'marketing_messages'), true);
	assert.strictEqual(shouldFallbackToCloudApi(parsed, 'messages'), false);
});

test('trap 5: 133010 means different things on the two endpoints', () => {
	// On Cloud API: the number never completed registration. On the MM API: the
	// business is not onboarded to MM Lite, and Cloud API will take the message.
	// Reported by a user whose credential worked with the official n8n node,
	// which only ever calls /messages.
	const parsed = parseWaError(httpError(133010, 'Account not registered'));

	assert.strictEqual(classifyWaError(parsed), 'fix_required');
	assert.strictEqual(shouldFallbackToCloudApi(parsed, 'marketing_messages'), true);
	assert.strictEqual(shouldFallbackToCloudApi(parsed, 'messages'), false);
	assert.strictEqual(shouldFallbackToMarketingApi(parsed, 'messages'), false);

	const guidance = explainWaError(parsed);
	assert.ok(guidance.includes('register'), guidance);
});

test('trap 4: fallback runs the other direction too', () => {
	const parsed = parseWaError(httpError(131063, 'marketing disabled on cloud api'));

	assert.strictEqual(shouldFallbackToMarketingApi(parsed, 'messages'), true);
	assert.strictEqual(shouldFallbackToMarketingApi(parsed, 'marketing_messages'), false);
});

// ---------------------------------------------------------------------------
// Guidance and surfacing
// ---------------------------------------------------------------------------

test('explainWaError gives a next step for the codes that need one', () => {
	const optOut = explainWaError(parseWaError(httpError(131050)));
	assert.ok(optOut && optOut.toLowerCase().includes('opted out'), optOut);

	const cap = explainWaError(parseWaError(httpError(131049)));
	assert.ok(cap && cap.includes('24 hours'), cap);

	assert.strictEqual(explainWaError(parseWaError(httpError(999999))), undefined);
});

test('toNodeError surfaces details, guidance, endpoint, template and fbtrace_id', () => {
	const error = toNodeError(fakeNode, httpError(134101, 'Template is not yet synced'), {
		itemIndex: 0,
		endpoint: 'POST /123/marketing_messages',
		templateName: 'summer_sale',
	});

	assert.ok(error.message.includes('134101'), error.message);
	assert.ok(error.message.includes('Template is not yet synced'), error.message);
	assert.ok(error.description.includes('summer_sale'), error.description);
	assert.ok(error.description.includes('POST /123/marketing_messages'), error.description);
	assert.ok(error.description.includes('mm_fallback'), error.description);
	assert.ok(error.description.includes('AbCdEfGhIjK'), error.description);
});

// ---------------------------------------------------------------------------
// 2026 platform changes
// ---------------------------------------------------------------------------

test('codes Meta added or redefined classify to an actionable disposition', () => {
	const cases = [
		// [code, class, disposition]
		[131062, 'fix_required', 'fix'], // BSUID not supported for this message type
		[131065, 'fix_required', 'fix'], // max price unavailable in the country
		[131008, 'fix_required', 'fix'],
		[132068, 'fix_required', 'fix'],
		[135000, 'fix_required', 'fix'],
		[130472, 'undeliverable', 'suppress'], // held out by an experiment
		[132069, 'deferred', 'retry_later'], // Flow throttled
		[133015, 'deferred', 'retry_later'],
	];

	for (const [code, cls, disposition] of cases) {
		assert.strictEqual(classifyWaError({ code, message: '' }), cls, String(code));
		assert.strictEqual(dispositionOf(cls), disposition, String(code));
		assert.ok(explainWaError({ code, message: '' }), 'no guidance for ' + code);
	}
});

test('none of the new codes is replayed on the other endpoint or retried inline', () => {
	for (const code of [131062, 131065, 130472, 131008, 132068, 132069, 135000]) {
		const error = { code, message: '' };
		assert.strictEqual(shouldFallbackToCloudApi(error, 'marketing_messages'), false, String(code));
		assert.strictEqual(shouldFallbackToMarketingApi(error, 'messages'), false, String(code));
		assert.strictEqual(isRetryable(error), false, String(code));
	}
});

test('an experiment hold-out gets no retry hint', () => {
	assert.strictEqual(retryAfterMs({ code: 130472, message: '' }), undefined);
});

test('guidance says what Meta documents for the codes it previously misdescribed', () => {
	assert.ok(/Payments/.test(explainWaError({ code: 134011, message: '' })));
	assert.ok(/unavailable/.test(explainWaError({ code: 134102, message: '' })));
	assert.ok(/validate/.test(explainWaError({ code: 132018, message: '' })));
	assert.ok(/registration or deregistration/.test(explainWaError({ code: 133016, message: '' })));
	assert.ok(/phone number/.test(explainWaError({ code: 131062, message: '' })));
});

done();
