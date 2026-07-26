'use strict';

/**
 * Guards on the things that would be quiet and expensive to get wrong: the
 * access token reaching an execution log, a crafted workflow file touching
 * Object.prototype, and remote text being compiled into a regex.
 */

const { assert, suite, test, done, fakeNode } = require('./harness');
const F = require('./fixtures');

const { toNodeError, parseWaError } = require('../dist/nodes/WhatsAppAdvanced/helpers/errors');
const {
	buildTemplateObject,
	autoMapValues,
} = require('../dist/nodes/WhatsAppAdvanced/helpers/payloadBuilder');
const {
	buildFieldsFromTemplate,
	renderPreview,
	extractPlaceholders,
} = require('../dist/nodes/WhatsAppAdvanced/helpers/templateParser');
const {
	sendUrl,
	fetchTemplates,
	invalidateTemplateCache,
} = require('../dist/nodes/WhatsAppAdvanced/transport');

const TOKEN = 'EAAG9ZBsecretTOKENvalue0987654321';

/**
 * What a failed HTTP request actually looks like: the whole request context
 * travels with the error, Authorization header included.
 */
function axiosStyleFailure(code) {
	const error = new Error('Request failed with status code 400');
	error.httpCode = '400';
	error.config = {
		url: 'https://graph.facebook.com/v23.0/106540352242922/messages',
		headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
	};
	error.request = { _header: `POST /v23.0/x/messages HTTP/1.1\nAuthorization: Bearer ${TOKEN}\n` };
	error.response = {
		status: 400,
		data: {
			error: {
				message: `(#${code}) Something Meta said`,
				type: 'OAuthException',
				code,
				error_data: { details: 'the detail string' },
				fbtrace_id: 'AbCdEfGhIjK',
			},
		},
	};
	return error;
}

/** Every string anywhere inside a value, however deeply nested. */
function deepStrings(value, seen = new Set()) {
	if (typeof value === 'string') return [value];
	if (value === null || typeof value !== 'object' || seen.has(value)) return [];
	seen.add(value);

	const out = [];
	for (const key of Object.getOwnPropertyNames(value)) {
		let child;
		try {
			child = value[key];
		} catch {
			continue;
		}
		out.push(key, ...deepStrings(child, seen));
	}
	return out;
}

suite('security.test.js — credential handling and injection surfaces');

// ---------------------------------------------------------------------------
// The access token must not survive into anything n8n stores or renders
// ---------------------------------------------------------------------------

test('the access token never reaches the wrapped error', () => {
	const wrapped = toNodeError(fakeNode, axiosStyleFailure(131049), {
		itemIndex: 0,
		endpoint: 'POST /106540352242922/marketing_messages',
		templateName: 'summer_sale',
	});

	const leaked = deepStrings(wrapped).filter(
		(text) => text.includes(TOKEN) || text.toLowerCase().includes('authorization'),
	);

	assert.deepStrictEqual(leaked, [], `token or auth header survived: ${leaked.join(' | ')}`);
});

test('the wrapped error still carries everything needed to debug', () => {
	const wrapped = toNodeError(fakeNode, axiosStyleFailure(131049), {
		endpoint: 'POST /1/marketing_messages',
		templateName: 'summer_sale',
	});

	assert.ok(wrapped.message.includes('131049'), wrapped.message);
	assert.ok(wrapped.message.includes('the detail string'), wrapped.message);
	assert.ok(wrapped.description.includes('AbCdEfGhIjK'), wrapped.description);
	assert.ok(wrapped.description.includes('summer_sale'), wrapped.description);

	// And it must still re-parse, which is what continueOnFail depends on.
	assert.strictEqual(parseWaError(wrapped).code, 131049);
});

test('the token does not leak through a re-parse of the wrapper either', () => {
	const wrapped = toNodeError(fakeNode, axiosStyleFailure(190), {});
	const reparsed = parseWaError(wrapped);

	const leaked = deepStrings(reparsed).filter((text) => text.includes(TOKEN));
	assert.deepStrictEqual(leaked, []);
	assert.strictEqual(reparsed.code, 190);
});

// ---------------------------------------------------------------------------
// Prototype pollution — a workflow file is user-editable JSON
// ---------------------------------------------------------------------------

test('a __proto__ key in stored mapper values cannot reach Object.prototype', () => {
	const values = JSON.parse(
		'{"h::loc::__proto__":"polluted","h::product::__proto__":"polluted",' +
			'"__proto__":"polluted","b::text::1":"safe"}',
	);

	buildTemplateObject({
		node: fakeNode,
		itemIndex: 0,
		templateName: 'x',
		languageCode: 'en_US',
		schema: [],
		values,
	});

	assert.strictEqual({}.polluted, undefined);
	assert.strictEqual(Object.prototype.polluted, undefined);
});

test('auto-map ignores inherited properties on the incoming item', () => {
	const parent = { customer_name: 'from-the-prototype' };
	const item = Object.create(parent);
	item.discount = '30%';

	const values = autoMapValues(buildFieldsFromTemplate(F.namedWithCouponAndOffer), item);

	assert.strictEqual(values['b::text::customer_name'], undefined);
	assert.strictEqual(values['b::text::discount'], '30%');
});

// ---------------------------------------------------------------------------
// Template text is remote data
// ---------------------------------------------------------------------------

test('a template body of regex metacharacters does not break the preview', () => {
	const nasty = {
		name: 'nasty',
		language: 'en_US',
		status: 'APPROVED',
		category: 'UTILITY',
		components: [
			{
				type: 'BODY',
				text: '(a+)+$ [x] .* {{1}} \\d ^end',
				example: { body_text: [['ok']] },
			},
		],
	};

	assert.deepStrictEqual(
		extractPlaceholders(nasty.components[0].text).map((p) => p.key),
		['1'],
	);
	assert.strictEqual(renderPreview(nasty), '(a+)+$ [x] .* ok \\d ^end');
});

test('a long adversarial template body still parses promptly', () => {
	const text = `${'{{'.repeat(2000)}${' '.repeat(2000)}{{1}}`;

	const started = Date.now();
	extractPlaceholders(text);
	const elapsed = Date.now() - started;

	assert.ok(elapsed < 1000, `took ${elapsed}ms — check for catastrophic backtracking`);
});

// ---------------------------------------------------------------------------
// Request URLs
// ---------------------------------------------------------------------------

test('a normal phone number ID builds the expected path', () => {
	assert.strictEqual(sendUrl('106540352242922', 'messages'), '/106540352242922/messages');
	assert.strictEqual(
		sendUrl('106540352242922', 'marketing_messages'),
		'/106540352242922/marketing_messages',
	);
});

test('a phone number ID that would move the request is refused', () => {
	for (const bad of [
		'../../me',
		'106540352242922?fields=x',
		'106540352242922#',
		'106540352242922/messages?x=1',
		'https://evil.example.com/x',
		'106 540352242922',
		'',
	]) {
		assert.throws(
			() => sendUrl(bad, 'messages'),
			/plain Graph API identifier/,
			`accepted “${bad}”`,
		);
	}
});

// ---------------------------------------------------------------------------
// Cache isolation — the template cache is shared by the whole n8n process
// ---------------------------------------------------------------------------

test('two credentials for the same WABA do not share cached templates', async () => {
	invalidateTemplateCache();

	const fetches = [];

	const tenant = (accessToken, templates) => ({
		getCredentials: async () => ({
			accessToken,
			businessAccountId: '102290129340398',
			graphApiVersion: 'v23.0',
		}),
		helpers: {
			httpRequestWithAuthentication: async (_type, request) => {
				fetches.push(accessToken);
				void request;
				return { data: templates, paging: {} };
			},
		},
	});

	const a = tenant('token-tenant-a', [{ ...F.threeBodyVars, name: 'tenant_a_secret_copy' }]);
	const b = tenant('token-tenant-b', [{ ...F.threeBodyVars, name: 'tenant_b_own_copy' }]);

	const first = await fetchTemplates.call(a, '102290129340398');
	const second = await fetchTemplates.call(b, '102290129340398');

	assert.strictEqual(first[0].name, 'tenant_a_secret_copy');

	// Tenant B must get its own answer, fetched with its own token — not tenant
	// A's cached rows served without any authorisation check.
	assert.strictEqual(second[0].name, 'tenant_b_own_copy');
	assert.deepStrictEqual(fetches, ['token-tenant-a', 'token-tenant-b']);

	// And the same credential is still served from cache.
	const again = await fetchTemplates.call(a, '102290129340398');
	assert.strictEqual(again[0].name, 'tenant_a_secret_copy');
	assert.strictEqual(fetches.length, 2, 'the repeat read should have hit the cache');

	invalidateTemplateCache();
});

test('rotating the access token drops the old cache entries', async () => {
	invalidateTemplateCache();
	let calls = 0;

	const withToken = (accessToken) => ({
		getCredentials: async () => ({ accessToken, businessAccountId: '999', graphApiVersion: 'v23.0' }),
		helpers: {
			httpRequestWithAuthentication: async () => {
				calls++;
				return { data: [], paging: {} };
			},
		},
	});

	await fetchTemplates.call(withToken('old-token'), '999');
	await fetchTemplates.call(withToken('new-token'), '999');

	assert.strictEqual(calls, 2, 'a rotated token must not read the previous token’s cache');
	invalidateTemplateCache();
});

test('surrounding whitespace is trimmed rather than rejected', () => {
	// A copy-pasted ID picking up a trailing space is a typo, not an attack, and
	// the trimmed value is what reaches the URL.
	assert.strictEqual(sendUrl('  106540352242922 ', 'messages'), '/106540352242922/messages');
});

done();
