'use strict';

/**
 * Phase 7b. Acceptance is not delivery — this suite is the guard on that
 * distinction, from both sides of the round trip.
 */

const { assert, suite, test, done } = require('./harness');

const {
	buildTrackingRef,
	normalizeSendResponse,
} = require('../dist/nodes/WhatsAppAdvanced/helpers/response');

const {
	parseStatusWebhook,
	isStatusWebhook,
} = require('../dist/nodes/WhatsAppAdvanced/helpers/webhook');

/** The exact accept payload the official node returns verbatim. */
const acceptPayload = {
	messaging_product: 'whatsapp',
	contacts: [{ input: '919824352916', wa_id: '919824352916' }],
	messages: [{ id: 'wamid.HBgMOTE5ODI0MzUyOTE2', message_status: 'accepted' }],
};

const statusWebhook = (status, extra = {}) => ({
	object: 'whatsapp_business_account',
	entry: [
		{
			id: '102290129340398',
			changes: [
				{
					field: 'messages',
					value: {
						messaging_product: 'whatsapp',
						metadata: {
							display_phone_number: '15550783881',
							phone_number_id: '106540352242922',
						},
						statuses: [
							{
								id: 'wamid.HBgMOTE5ODI0MzUyOTE2',
								status,
								timestamp: '1769000200',
								recipient_id: '919824352916',
								biz_opaque_callback_data: 'n8n:4821:0:summer_sale',
								conversation: { id: 'conv-1', origin: { type: 'marketing' } },
								pricing: { billable: true, category: 'marketing_lite' },
								...extra,
							},
						],
					},
				},
			],
		},
	],
});

suite('webhook.test.js — acceptance versus delivery');

// ---------------------------------------------------------------------------
// Send side
// ---------------------------------------------------------------------------

test('accepted normalises to delivered: false', () => {
	const result = normalizeSendResponse(acceptPayload, {
		endpoint: 'POST /106540352242922/marketing_messages',
		routedVia: 'marketing_messages',
	});

	assert.strictEqual(result.delivered, false);
	assert.strictEqual(result.status, 'accepted');
});

test('Meta’s message_status is preserved verbatim', () => {
	const odd = { messages: [{ id: 'wamid.X', message_status: 'something_new' }] };
	assert.strictEqual(
		normalizeSendResponse(odd, { endpoint: 'e', routedVia: 'messages' }).status,
		'something_new',
	);
});

test('messageId, recipient, endpoint and template are extracted', () => {
	const result = normalizeSendResponse(acceptPayload, {
		endpoint: 'POST /106540352242922/marketing_messages',
		routedVia: 'marketing_messages',
		templateName: 'summer_sale',
		languageCode: 'en_US',
		category: 'MARKETING',
		trackingRef: 'n8n:4821:0:summer_sale',
	});

	assert.strictEqual(result.messageId, 'wamid.HBgMOTE5ODI0MzUyOTE2');
	assert.strictEqual(result.recipient.waId, '919824352916');
	assert.strictEqual(result.recipient.input, '919824352916');
	assert.strictEqual(result.endpoint, 'POST /106540352242922/marketing_messages');
	assert.strictEqual(result.routedVia, 'marketing_messages');
	assert.deepStrictEqual(result.template, {
		name: 'summer_sale',
		language: 'en_US',
		category: 'MARKETING',
	});
	assert.ok(Date.parse(result.sentAt) > 0);
});

test('the raw response is attached only when asked for', () => {
	const ctx = { endpoint: 'e', routedVia: 'messages' };
	assert.strictEqual(normalizeSendResponse(acceptPayload, ctx).raw, undefined);
	assert.deepStrictEqual(
		normalizeSendResponse(acceptPayload, { ...ctx, includeRaw: true }).raw,
		acceptPayload,
	);
});

test('a tracking ref is generated when absent and respected when supplied', () => {
	assert.strictEqual(
		buildTrackingRef(undefined, { executionId: '4821', itemIndex: 0, templateName: 'summer_sale' }),
		'n8n:4821:0:summer_sale',
	);
	assert.strictEqual(
		buildTrackingRef('crm-order-8823', { executionId: '4821', itemIndex: 0 }),
		'crm-order-8823',
	);
	assert.strictEqual(buildTrackingRef('   ', { executionId: '1', itemIndex: 2 }), 'n8n:1:2');
});

test('a tracking ref is capped at Meta’s 512-character limit', () => {
	const long = 'x'.repeat(900);
	assert.strictEqual(buildTrackingRef(long, { itemIndex: 0 }).length, 512);
});

// ---------------------------------------------------------------------------
// Webhook side
// ---------------------------------------------------------------------------

test('sent means it left Meta, not that it arrived', () => {
	const [event] = parseStatusWebhook(statusWebhook('sent'));
	assert.strictEqual(event.status, 'sent');
	assert.strictEqual(event.delivered, false);
});

test('delivered sets delivered: true and surfaces MM API pricing', () => {
	const [event] = parseStatusWebhook(statusWebhook('delivered'));

	assert.strictEqual(event.delivered, true);
	assert.strictEqual(event.pricingCategory, 'marketing_lite');
	assert.strictEqual(event.billable, true);
	assert.strictEqual(event.conversationId, 'conv-1');
	assert.strictEqual(event.conversationOrigin, 'marketing');
});

test('read also counts as delivered', () => {
	assert.strictEqual(parseStatusWebhook(statusWebhook('read'))[0].delivered, true);
});

test('Meta’s Unix seconds become an ISO timestamp', () => {
	const [event] = parseStatusWebhook(statusWebhook('delivered'));
	assert.strictEqual(event.timestamp, new Date(1769000200 * 1000).toISOString());
});

test('the tracking ref comes back so send and outcome can be joined', () => {
	const [event] = parseStatusWebhook(statusWebhook('delivered'));
	assert.strictEqual(event.trackingRef, 'n8n:4821:0:summer_sale');
	assert.strictEqual(event.phoneNumberId, '106540352242922');
	assert.strictEqual(event.displayPhoneNumber, '15550783881');
});

test('a webhook 131049 classifies exactly as the send path would', () => {
	const [event] = parseStatusWebhook(
		statusWebhook('failed', {
			errors: [
				{
					code: 131049,
					title: 'This message was not delivered to maintain healthy ecosystem engagement.',
					error_data: { details: 'Per-user marketing template message limit reached.' },
					href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
				},
			],
		}),
	);

	assert.strictEqual(event.delivered, false);
	assert.strictEqual(event.code, 131049);
	assert.strictEqual(event.errorClass, 'deferred');
	assert.strictEqual(event.disposition, 'retry_later');
	assert.strictEqual(event.retryAfterMs, 24 * 60 * 60 * 1000);
	assert.ok(Date.parse(event.retryAfter) > Date.now());
});

test('the href only webhook errors carry is surfaced', () => {
	const [event] = parseStatusWebhook(
		statusWebhook('failed', {
			errors: [{ code: 131026, title: 'Message undeliverable', href: 'https://x.example' }],
		}),
	);
	assert.strictEqual(event.href, 'https://x.example');
	assert.strictEqual(event.title, 'Message undeliverable');
});

test('a webhook opt-out gets no retryAfter, so it cannot enter a retry loop', () => {
	const [event] = parseStatusWebhook(
		statusWebhook('failed', {
			errors: [
				{
					code: 131050,
					title: 'Unable to deliver message',
					error_data: { details: 'The user has opted out of marketing messages.' },
				},
			],
		}),
	);

	assert.strictEqual(event.errorClass, 'opt_out');
	assert.strictEqual(event.disposition, 'suppress');
	assert.strictEqual(event.retryAfterMs, undefined);
	assert.strictEqual(event.retryAfter, undefined);
	assert.ok(event.guidance.toLowerCase().includes('opted out'), event.guidance);
});

test('a bare change value parses, because trigger configurations differ', () => {
	const bare = statusWebhook('delivered').entry[0].changes[0].value;
	const events = parseStatusWebhook(bare);

	assert.strictEqual(events.length, 1);
	assert.strictEqual(events[0].delivered, true);
	assert.strictEqual(isStatusWebhook(bare), true);
});

test('an inbound-message webhook is not a status webhook', () => {
	const inbound = {
		object: 'whatsapp_business_account',
		entry: [
			{
				id: '102290129340398',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: { phone_number_id: '106540352242922' },
							contacts: [{ profile: { name: 'Ravi' }, wa_id: '919824352916' }],
							messages: [
								{
									from: '919824352916',
									id: 'wamid.IN',
									timestamp: '1769000000',
									type: 'text',
									text: { body: 'Where is my order?' },
								},
							],
						},
					},
				],
			},
		],
	};

	assert.strictEqual(isStatusWebhook(inbound), false);
	assert.deepStrictEqual(parseStatusWebhook(inbound), []);
});

test('account-level errors beside statuses are classified, not dropped', () => {
	const payload = statusWebhook('sent');
	payload.entry[0].changes[0].value.errors = [
		{ code: 190, title: 'Access token has expired', error_data: { details: 'Session expired' } },
	];

	const events = parseStatusWebhook(payload);
	const accountLevel = events.find((event) => event.accountLevel === true);

	assert.strictEqual(events.length, 2);
	assert.strictEqual(accountLevel.code, 190);
	assert.strictEqual(accountLevel.errorClass, 'auth');
	assert.strictEqual(accountLevel.disposition, 'fix');
	assert.strictEqual(accountLevel.delivered, false);
});

test('includeRaw attaches Meta’s untouched status object', () => {
	const [event] = parseStatusWebhook(statusWebhook('delivered'), true);
	assert.strictEqual(event.raw.id, 'wamid.HBgMOTE5ODI0MzUyOTE2');
	assert.strictEqual(parseStatusWebhook(statusWebhook('delivered'))[0].raw, undefined);
});

test('a payload with neither statuses nor errors is not mistaken for one', () => {
	assert.strictEqual(isStatusWebhook({}), false);
	assert.strictEqual(isStatusWebhook({ entry: [] }), false);
	assert.deepStrictEqual(parseStatusWebhook({}), []);
});

done();
