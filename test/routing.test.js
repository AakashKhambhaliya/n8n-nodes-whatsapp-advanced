'use strict';

/**
 * Phase 7. Drives the real `execute()` against a fake `IExecuteFunctions`, so
 * endpoint routing, inline retries, both fallback directions and non-delivery
 * handling are exercised end to end without n8n or a network.
 */

const { assert, suite, test, done, fakeNode } = require('./harness');
const F = require('./fixtures');

const {
	WhatsAppAdvanced,
} = require('../dist/nodes/WhatsAppAdvanced/WhatsAppAdvanced.node');
const {
	invalidateTemplateCache,
} = require('../dist/nodes/WhatsAppAdvanced/transport');

const WABA_ID = '102290129340398';
const PHONE_ID = '106540352242922';

const ACCEPTED = {
	messaging_product: 'whatsapp',
	contacts: [{ input: '919824352916', wa_id: '919824352916' }],
	messages: [{ id: 'wamid.HBgMOTE5ODI0MzUyOTE2', message_status: 'accepted' }],
};

/** Meta's HTTP failure shape, as n8n's helper surfaces it. */
function graphFailure(code, details) {
	const error = new Error(`Request failed with status code 400`);
	error.httpCode = '400';
	error.cause = {
		error: {
			message: `(#${code}) ${details}`,
			type: 'OAuthException',
			code,
			error_data: { messaging_product: 'whatsapp', details },
			fbtrace_id: 'AbCdEfGhIjK',
		},
	};
	return error;
}

/**
 * @param {object} opts
 * @param {object[]} opts.templates   what GET message_templates returns
 * @param {object} opts.params        node parameters
 * @param {function} opts.send        (endpoint, body) => response, or throws
 */
function makeContext(opts) {
	const calls = [];

	const params = {
		resource: 'message',
		operation: 'sendTemplate',
		phoneNumberId: PHONE_ID,
		recipientPhoneNumber: '+91 98243 52916',
		messagingEndpoint: 'auto',
		options: {},
		templateParameters: { mappingMode: 'defineBelow', value: {}, schema: [] },
		...opts.params,
	};

	return {
		calls,
		getInputData: () => opts.items ?? [{ json: {} }],
		getNode: () => fakeNode,
		getExecutionId: () => '4821',
		continueOnFail: () => opts.continueOnFail === true,
		getCredentials: async () => {
			if (opts.noCredentials) throw new Error('Credentials not set');
			return { accessToken: 'tok', businessAccountId: WABA_ID, graphApiVersion: 'v23.0' };
		},
		getNodeParameter(name, _itemIndex, fallback) {
			if (!(name in params)) return fallback;
			const value = params[name];
			return value === undefined ? fallback : value;
		},
		helpers: {
			httpRequestWithAuthentication: async (_type, request) => {
				const url = request.url;
				calls.push({ method: request.method, url, body: request.body });

				if (url.includes('/message_templates')) {
					return { data: opts.templates ?? [], paging: {} };
				}

				const endpoint = url.endsWith('/marketing_messages')
					? 'marketing_messages'
					: 'messages';

				return opts.send(endpoint, request.body);
			},
		},
	};
}

async function run(opts) {
	invalidateTemplateCache();
	const context = makeContext(opts);
	const output = await new WhatsAppAdvanced().execute.call(context);
	return { items: output[0].map((entry) => entry.json), calls: context.calls };
}

const sendCalls = (calls) => calls.filter((call) => !call.url.includes('/message_templates'));

const filled = (template, values) => ({
	mappingMode: 'defineBelow',
	value: values,
	schema: require('../dist/nodes/WhatsAppAdvanced/helpers/templateParser').buildFieldsFromTemplate(
		template,
	),
});

suite('routing.test.js — endpoint selection, retries and fallback');

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('a MARKETING template auto-routes to /marketing_messages', async () => {
	const { calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: {
			template: 'summer_sale|en_US',
			templateParameters: filled(F.namedWithCouponAndOffer, {
				'h::text::store_name': 'Aloe & Co',
				'b::text::customer_name': 'Priya',
				'b::text::discount': '30%',
				'btn::0::copy_code': 'SUMMER30',
				'lto::expiration_time_ms': 1769000000000,
			}),
		},
		send: () => ACCEPTED,
	});

	const sends = sendCalls(calls);
	assert.strictEqual(sends.length, 1);
	assert.ok(sends[0].url.endsWith(`/${PHONE_ID}/marketing_messages`), sends[0].url);
});

test('a UTILITY template auto-routes to /messages', async () => {
	const { calls } = await run({
		templates: [F.threeBodyVars],
		params: {
			template: 'ordering_check|en_US',
			templateParameters: filled(F.threeBodyVars, {
				'b::text::1': 'a',
				'b::text::2': 'b',
				'b::text::3': 'c',
			}),
		},
		send: () => ACCEPTED,
	});

	assert.ok(sendCalls(calls)[0].url.endsWith(`/${PHONE_ID}/messages`));
});

test('forcing a UTILITY template onto the MM API fails inside n8n', async () => {
	await assert.rejects(
		run({
			templates: [F.threeBodyVars],
			params: {
				messagingEndpoint: 'marketing_messages',
				template: 'ordering_check|en_US',
				templateParameters: filled(F.threeBodyVars, {
					'b::text::1': 'a',
					'b::text::2': 'b',
					'b::text::3': 'c',
				}),
			},
			send: () => {
				throw new Error('should never reach Meta');
			},
		}),
		(error) => {
			assert.ok(error.message.includes('UTILITY'), error.message);
			return true;
		},
	);
});

test('a template that is not on the account is named, not left to Meta', async () => {
	await assert.rejects(
		run({
			templates: [],
			params: { template: 'no_such_template|en_US' },
			send: () => ACCEPTED,
		}),
		/No template named/,
	);
});

test('a template that is not APPROVED is refused before sending', async () => {
	await assert.rejects(
		run({
			templates: [{ ...F.threeBodyVars, status: 'PAUSED' }],
			params: {
				template: 'ordering_check|en_US',
				templateParameters: filled(F.threeBodyVars, {
					'b::text::1': 'a',
					'b::text::2': 'b',
					'b::text::3': 'c',
				}),
			},
			send: () => ACCEPTED,
		}),
		/is PAUSED, not APPROVED/,
	);
});

test('Validate Only assembles the payload without sending', async () => {
	const { items, calls } = await run({
		templates: [F.threeBodyVars],
		params: {
			options: { validateOnly: true },
			template: 'ordering_check|en_US',
			templateParameters: filled(F.threeBodyVars, {
				'b::text::1': 'a',
				'b::text::2': 'b',
				'b::text::3': 'c',
			}),
		},
		send: () => {
			throw new Error('should never send');
		},
	});

	assert.strictEqual(sendCalls(calls).length, 0);
	assert.strictEqual(items[0].validated, true);
	assert.strictEqual(items[0].templateStatus, 'APPROVED');
	assert.ok(items[0].preview.length > 0);
	assert.strictEqual(items[0].body.template.name, 'ordering_check');
});

// ---------------------------------------------------------------------------
// MM-only fields
// ---------------------------------------------------------------------------

const marketingParams = (extra = {}) => ({
	template: 'summer_sale|en_US',
	templateParameters: filled(F.namedWithCouponAndOffer, {
		'h::text::store_name': 'Aloe & Co',
		'b::text::customer_name': 'Priya',
		'b::text::discount': '30%',
		'btn::0::copy_code': 'SUMMER30',
		'lto::expiration_time_ms': 1769000000000,
	}),
	...extra,
});

test('MM-only fields are attached on the MM API', async () => {
	const { calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({
			options: { messageActivitySharing: true, messageSendTtlSeconds: 43200 },
		}),
		send: () => ACCEPTED,
	});

	const body = sendCalls(calls)[0].body;
	assert.strictEqual(body.message_activity_sharing, true);
	assert.strictEqual(body.message_send_ttl_seconds, 43200);
});

test('MM-only fields are never sent to /messages', async () => {
	const { calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({
			messagingEndpoint: 'messages',
			options: { messageActivitySharing: true, messageSendTtlSeconds: 43200 },
		}),
		send: () => ACCEPTED,
	});

	const body = sendCalls(calls)[0].body;
	assert.strictEqual(body.message_activity_sharing, undefined);
	assert.strictEqual(body.message_send_ttl_seconds, undefined);
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

test('134101 falls back to the Cloud API and drops the MM-only fields', async () => {
	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({
			options: { messageActivitySharing: true, messageSendTtlSeconds: 43200 },
		}),
		send: (endpoint) => {
			if (endpoint === 'marketing_messages') {
				throw graphFailure(134101, 'Template is not yet synced to the ad account');
			}
			return ACCEPTED;
		},
	});

	const sends = sendCalls(calls);
	assert.strictEqual(sends.length, 2);
	assert.ok(sends[0].url.endsWith('/marketing_messages'));
	assert.ok(sends[1].url.endsWith('/messages'));

	assert.strictEqual(sends[1].body.message_activity_sharing, undefined);
	assert.strictEqual(sends[1].body.message_send_ttl_seconds, undefined);
	assert.strictEqual(sends[1].body.biz_opaque_callback_data, 'n8n:4821:0:summer_sale');

	assert.strictEqual(items[0]._routedVia, 'messages');
	assert.strictEqual(items[0]._fallbackFrom, 'marketing_messages');
	assert.strictEqual(items[0]._fallbackCode, 134101);
	assert.strictEqual(items[0].delivered, false);
	assert.strictEqual(items[0].status, 'accepted');
});

test('133010 on the MM API falls back instead of failing the send', async () => {
	// An account that is not onboarded to MM Lite answers /marketing_messages
	// with "Account not registered". The same credential sends fine on Cloud API,
	// which is why this looked like a broken node next to the official one.
	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams(),
		send: (endpoint) => {
			if (endpoint === 'marketing_messages') {
				throw graphFailure(133010, 'Account not registered');
			}
			return ACCEPTED;
		},
	});

	const sends = sendCalls(calls);
	assert.strictEqual(sends.length, 2);
	assert.ok(sends[0].url.endsWith('/marketing_messages'));
	assert.ok(sends[1].url.endsWith('/messages'));

	assert.strictEqual(items[0].status, 'accepted');
	assert.strictEqual(items[0]._routedVia, 'messages');
	assert.strictEqual(items[0]._fallbackCode, 133010);
});

test('133010 on the Cloud API is still a real registration failure', async () => {
	// Nothing to reroute to — the number genuinely is not registered.
	await assert.rejects(
		run({
			templates: [F.namedWithCouponAndOffer],
			params: marketingParams({ messagingEndpoint: 'messages' }),
			send: () => {
				throw graphFailure(133010, 'Account not registered');
			},
		}),
		/133010/,
	);
});

test('131063 falls back the other direction, onto the MM API', async () => {
	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({ messagingEndpoint: 'messages' }),
		send: (endpoint) => {
			if (endpoint === 'messages') {
				throw graphFailure(131063, 'Marketing messages are disabled on Cloud API');
			}
			return ACCEPTED;
		},
	});

	const sends = sendCalls(calls);
	assert.ok(sends[0].url.endsWith('/messages'));
	assert.ok(sends[1].url.endsWith('/marketing_messages'));
	assert.strictEqual(items[0]._fallbackFrom, 'messages');
	assert.strictEqual(items[0]._fallbackCode, 131063);
});

test('an opt-out is never replayed on the other endpoint', async () => {
	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams(),
		send: () => {
			throw graphFailure(131050, 'The user has opted out of marketing messages');
		},
	});

	assert.strictEqual(sendCalls(calls).length, 1);
	assert.strictEqual(items[0]._disposition, 'suppress');
	assert.strictEqual(items[0]._errorClass, 'opt_out');
	assert.strictEqual(items[0]._retryAfter, undefined);
	assert.strictEqual(items[0]._retryAfterMs, undefined);
});

test('a fallback that also fails still produces classified output, not a throw', async () => {
	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams(),
		send: (endpoint) => {
			if (endpoint === 'marketing_messages') throw graphFailure(134101, 'still syncing');
			throw graphFailure(131049, 'Per-user marketing cap reached');
		},
	});

	assert.strictEqual(sendCalls(calls).length, 2);
	// The reported error is the one the *second* attempt produced.
	assert.strictEqual(items[0]._code, 131049);
	assert.strictEqual(items[0]._disposition, 'retry_later');
	assert.ok(items[0]._attemptedEndpoint.endsWith('/messages'), items[0]._attemptedEndpoint);
});

test('Fall Back to Cloud API off means no replay, and the message is not discarded', async () => {
	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({ options: { fallbackToCloudApi: false } }),
		send: () => {
			throw graphFailure(134101, 'still syncing');
		},
	});

	assert.strictEqual(sendCalls(calls).length, 1);

	// The reroute was the remedy and it is switched off — but Meta documents a
	// 10-minute wait for this code, so it defers instead of throwing the message
	// away.
	assert.strictEqual(items[0]._errorClass, 'deferred');
	assert.strictEqual(items[0]._disposition, 'retry_later');
	assert.strictEqual(items[0]._retryAfterMs, 10 * 60 * 1000);
});

test('an ineligibility with no documented wait still throws', async () => {
	// 134102 is "the account is not onboarded to the MM API" — a human has to
	// accept the Terms of Service. Deferring it would retry forever.
	await assert.rejects(
		run({
			templates: [F.namedWithCouponAndOffer],
			params: marketingParams({ options: { fallbackToCloudApi: false } }),
			send: () => {
				throw graphFailure(134102, 'Business account is not onboarded');
			},
		}),
		/134102/,
	);
});

// ---------------------------------------------------------------------------
// Retries and non-delivery
// ---------------------------------------------------------------------------

test('a frequency cap is deferred with a 24-hour retry hint', async () => {
	const { items } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams(),
		send: () => {
			throw graphFailure(131049, 'Per-user marketing cap reached');
		},
	});

	assert.strictEqual(items[0]._delivered, false);
	assert.strictEqual(items[0]._errorClass, 'deferred');
	assert.strictEqual(items[0]._disposition, 'retry_later');
	assert.strictEqual(items[0]._retryAfterMs, 24 * 60 * 60 * 1000);
	assert.ok(Date.parse(items[0]._retryAfter) > Date.now());
	assert.strictEqual(items[0]._trackingRef, 'n8n:4821:0:summer_sale');
	assert.strictEqual(items[0]._recipient, '919824352916');
});

test('a transient failure is retried, then downgraded to deferred', async () => {
	let attempts = 0;

	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({ options: { maxRetries: 1 } }),
		send: () => {
			attempts++;
			throw graphFailure(130429, 'Rate limit hit');
		},
	});

	assert.strictEqual(attempts, 2, 'one initial attempt plus one retry');
	assert.strictEqual(sendCalls(calls).length, 2);
	// retryable stopped being "try again in a second" when the retries ran out.
	assert.strictEqual(items[0]._errorClass, 'deferred');
	assert.strictEqual(items[0]._disposition, 'retry_later');
});

test('a transient failure that clears on retry succeeds', async () => {
	let attempts = 0;

	const { items } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({ options: { maxRetries: 1 } }),
		send: () => {
			attempts++;
			if (attempts === 1) throw graphFailure(131016, 'Service unavailable');
			return ACCEPTED;
		},
	});

	assert.strictEqual(items[0].status, 'accepted');
	assert.strictEqual(items[0].messageId, 'wamid.HBgMOTE5ODI0MzUyOTE2');
});

test('Non-Delivery Handling set to error throws instead of emitting an item', async () => {
	await assert.rejects(
		run({
			templates: [F.namedWithCouponAndOffer],
			params: marketingParams({ options: { nonDeliveryHandling: 'error' } }),
			send: () => {
				throw graphFailure(131050, 'The user has opted out');
			},
		}),
		/131050/,
	);
});

test('a fix_required code throws rather than being quietly re-queued', async () => {
	await assert.rejects(
		run({
			templates: [F.namedWithCouponAndOffer],
			params: marketingParams(),
			send: () => {
				throw graphFailure(132016, 'Template disabled for quality reasons');
			},
		}),
		/132016/,
	);
});

// ---------------------------------------------------------------------------
// Output shape and other resources
// ---------------------------------------------------------------------------

test('a successful send is normalised and carries a tracking ref', async () => {
	const { items, calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams(),
		send: () => ACCEPTED,
	});

	assert.strictEqual(sendCalls(calls)[0].body.biz_opaque_callback_data, 'n8n:4821:0:summer_sale');
	assert.deepStrictEqual(items[0].template, {
		name: 'summer_sale',
		language: 'en_US',
		category: 'MARKETING',
	});
	assert.strictEqual(items[0].delivered, false);
	assert.strictEqual(items[0].trackingRef, 'n8n:4821:0:summer_sale');
	assert.strictEqual(items[0].routedVia, 'marketing_messages');
});

test('Normalize Output off returns Meta’s raw accept payload', async () => {
	const { items } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams({ options: { normalizeOutput: false } }),
		send: () => ACCEPTED,
	});

	assert.deepStrictEqual(items[0], ACCEPTED);
});

test('continueOnFail emits the classification instead of failing the run', async () => {
	const { items } = await run({
		templates: [F.namedWithCouponAndOffer],
		continueOnFail: true,
		params: marketingParams({ options: { nonDeliveryHandling: 'error' } }),
		send: () => {
			throw graphFailure(190, 'Access token has expired');
		},
	});

	assert.strictEqual(items[0].code, 190);
	assert.strictEqual(items[0].errorClass, 'auth');
	assert.strictEqual(items[0].disposition, 'fix');
	assert.strictEqual(items[0].fbtraceId, 'AbCdEfGhIjK');
});

test('missing variables are named before anything reaches Meta', async () => {
	const { items } = await run({
		templates: [F.fourRequiredVars],
		continueOnFail: true,
		params: {
			template: 'shipment_notice|en_US',
			templateParameters: filled(F.fourRequiredVars, { 'h::text::1': 'A-8823' }),
		},
		send: () => {
			throw new Error('should never send');
		},
	});

	assert.ok(items[0].error.includes('missing 3 required variables'), items[0].error);
	assert.strictEqual(items[0].code, undefined);
});

test('auto-map mode resolves the incoming item through execute()', async () => {
	const { calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		items: [
			{
				json: {
					store_name: 'Aloe & Co',
					customer_name: 'Priya',
					discount: '30%',
					copy_code: 'SUMMER30',
					expiration_time_ms: 1769000000000,
				},
			},
		],
		params: {
			template: 'summer_sale|en_US',
			templateParameters: {
				mappingMode: 'autoMapInputData',
				// n8n leaves this null in auto-map mode.
				value: null,
				schema: require('../dist/nodes/WhatsAppAdvanced/helpers/templateParser').buildFieldsFromTemplate(
					F.namedWithCouponAndOffer,
				),
			},
		},
		send: () => ACCEPTED,
	});

	const body = sendCalls(calls)[0].body;
	assert.deepStrictEqual(body.template.components[1], {
		type: 'body',
		parameters: [
			{ type: 'text', text: 'Priya', parameter_name: 'customer_name' },
			{ type: 'text', text: '30%', parameter_name: 'discount' },
		],
	});
});

test('the Delivery Status resource never asks for credentials', async () => {
	const { items } = await run({
		noCredentials: true,
		params: {
			resource: 'status',
			operation: 'parseWebhook',
			statusOptions: {},
			webhookPayload: {
				object: 'whatsapp_business_account',
				entry: [
					{
						id: WABA_ID,
						changes: [
							{
								field: 'messages',
								value: {
									metadata: { phone_number_id: PHONE_ID },
									statuses: [
										{
											id: 'wamid.X',
											status: 'delivered',
											timestamp: '1769000200',
											recipient_id: '919824352916',
										},
									],
								},
							},
						],
					},
				],
			},
		},
		send: () => {
			throw new Error('should never send');
		},
	});

	assert.strictEqual(items.length, 1);
	assert.strictEqual(items[0].delivered, true);
});

test('sendText always goes to /messages', async () => {
	const { calls } = await run({
		params: { operation: 'sendText', textBody: 'Where is my order?' },
		send: () => ({ messages: [{ id: 'wamid.T' }] }),
	});

	const sends = sendCalls(calls);
	assert.strictEqual(sends.length, 1);
	assert.ok(sends[0].url.endsWith(`/${PHONE_ID}/messages`));
	assert.strictEqual(sends[0].body.type, 'text');
});

test('the recipient number is stripped to digits on the wire', async () => {
	const { calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		params: marketingParams(),
		send: () => ACCEPTED,
	});

	assert.strictEqual(sendCalls(calls)[0].body.to, '919824352916');
});

test('the category lookup is cached across items in one run', async () => {
	const { calls } = await run({
		templates: [F.namedWithCouponAndOffer],
		items: [{ json: {} }, { json: {} }, { json: {} }],
		params: marketingParams(),
		send: () => ACCEPTED,
	});

	const templateReads = calls.filter((call) => call.url.includes('/message_templates'));
	assert.strictEqual(templateReads.length, 1, 'three items, one template read');
	assert.strictEqual(sendCalls(calls).length, 3);
});

done();
