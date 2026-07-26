'use strict';

/**
 * Phase 3 + Phase 4. Requires from dist/, so `npm run build` must have run.
 * No n8n instance and no network: the parser and the payload builder are pure.
 */

const { assert, suite, test, done, fakeNode, ids, labelFor } = require('./harness');
const F = require('./fixtures');

const {
	buildFieldsFromTemplate,
	renderPreview,
	extractPlaceholders,
	contextSnippet,
	isPositionalKey,
} = require('../dist/nodes/WhatsAppAdvanced/helpers/templateParser');

const {
	buildTemplateObject,
	buildSendBody,
	sanitizePhoneNumber,
	shortLabel,
	mediaObject,
	autoMapKey,
	autoMapValues,
} = require('../dist/nodes/WhatsAppAdvanced/helpers/payloadBuilder');

const build = (template, values) =>
	buildTemplateObject({
		node: fakeNode,
		itemIndex: 0,
		templateName: template.name,
		languageCode: template.language,
		schema: buildFieldsFromTemplate(template),
		values,
		category: template.category,
	});

suite('templates.test.js — parser and payload builder');

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

test('isPositionalKey separates {{1}} from {{customer_name}}', () => {
	assert.strictEqual(isPositionalKey('1'), true);
	assert.strictEqual(isPositionalKey('12'), true);
	assert.strictEqual(isPositionalKey('customer_name'), false);
	assert.strictEqual(isPositionalKey('a1'), false);
});

test('extractPlaceholders de-duplicates a repeated variable', () => {
	const body = F.repeatedPlaceholder.components[0];
	assert.deepStrictEqual(
		extractPlaceholders(body.text).map((p) => p.key),
		['1'],
	);
	assert.deepStrictEqual(ids(buildFieldsFromTemplate(F.repeatedPlaceholder)), ['b::text::1']);
});

test('contextSnippet marks the target variable and leaves neighbours alone', () => {
	const text = 'Hi {{1}}, your order #{{2}} ships on {{3}}.';
	const [first] = extractPlaceholders(text);
	const snippet = contextSnippet(text, first);

	assert.ok(snippet.includes('⟨1⟩'), snippet);
	assert.ok(snippet.includes('{{2}}'), snippet);
	assert.ok(!snippet.includes('{{1}}'), snippet);
});

test('mediaObject picks link for a URL and id for a media ID', () => {
	assert.deepStrictEqual(mediaObject('https://x.example.com/a.jpg'), {
		link: 'https://x.example.com/a.jpg',
	});
	assert.deepStrictEqual(mediaObject('1558081531584829'), { id: '1558081531584829' });
	assert.deepStrictEqual(mediaObject('4::aG', 'invoice.pdf'), {
		id: '4::aG',
		filename: 'invoice.pdf',
	});
});

test('sanitizePhoneNumber strips everything that is not a digit', () => {
	assert.strictEqual(sanitizePhoneNumber('+1 (415) 555-2671'), '14155552671');
});

// ---------------------------------------------------------------------------
// Fixture 1 — POSITIONAL, IMAGE header, dynamic URL, static quick reply
// ---------------------------------------------------------------------------

test('fixture 1: generates media, body and dynamic-URL fields', () => {
	const fields = buildFieldsFromTemplate(F.positionalWithImageHeader);

	assert.deepStrictEqual(ids(fields), [
		'h::media::image',
		'b::text::1',
		'b::text::2',
		'b::text::3',
		'btn::0::url::1',
		'btn::1::quick_reply_payload',
	]);
});

test('fixture 1: a standalone quick reply hides behind Add variable', () => {
	const fields = buildFieldsFromTemplate(F.positionalWithImageHeader);
	const quickReply = fields.find((f) => f.id === 'btn::1::quick_reply_payload');

	assert.strictEqual(quickReply.removed, true);
	assert.strictEqual(quickReply.required, false);
});

test('fixture 1: the body label carries the variable, its context and Meta’s example', () => {
	const fields = buildFieldsFromTemplate(F.positionalWithImageHeader);
	const label = labelFor(fields, 'b::text::1');

	assert.ok(label.startsWith('Body · {{1}} ·'), label);
	assert.ok(label.includes('⟨1⟩'), label);
	assert.ok(label.endsWith('(e.g. Ravi)'), label);
});

test('fixture 1: a URL header value serialises as { link }', () => {
	const template = build(F.positionalWithImageHeader, {
		'h::media::image': 'https://cdn.example.com/order.jpg',
		'b::text::1': 'Ravi',
		'b::text::2': 'A-8823',
		'b::text::3': 'Friday',
		'btn::0::url::1': 'A-8823',
	});

	assert.deepStrictEqual(template, {
		name: 'order_update',
		language: { code: 'en_US' },
		components: [
			{
				type: 'header',
				parameters: [
					{ type: 'image', image: { link: 'https://cdn.example.com/order.jpg' } },
				],
			},
			{
				type: 'body',
				parameters: [
					{ type: 'text', text: 'Ravi' },
					{ type: 'text', text: 'A-8823' },
					{ type: 'text', text: 'Friday' },
				],
			},
			{ type: 'button', index: '0', sub_type: 'url', parameters: [{ type: 'text', text: 'A-8823' }] },
		],
	});
});

test('fixture 1: no parameter_name is emitted on a positional template', () => {
	const template = build(F.positionalWithImageHeader, {
		'h::media::image': 'https://cdn.example.com/order.jpg',
		'b::text::1': 'Ravi',
		'b::text::2': 'A-8823',
		'b::text::3': 'Friday',
		'btn::0::url::1': 'A-8823',
	});

	for (const parameter of template.components[1].parameters) {
		assert.ok(!('parameter_name' in parameter), JSON.stringify(parameter));
	}
});

// ---------------------------------------------------------------------------
// Fixture 2 — NAMED, coupon button, limited-time offer
// ---------------------------------------------------------------------------

test('fixture 2: named variables, coupon and offer expiry all get fields', () => {
	assert.deepStrictEqual(ids(buildFieldsFromTemplate(F.namedWithCouponAndOffer)), [
		'h::text::store_name',
		'b::text::customer_name',
		'b::text::discount',
		'lto::expiration_time_ms',
		'btn::0::copy_code',
	]);
});

test('fixture 2: a static URL button generates no field', () => {
	const fields = buildFieldsFromTemplate(F.namedWithCouponAndOffer);
	assert.ok(!fields.some((f) => f.id.startsWith('btn::1::')));
});

test('fixture 2: parameter_name is emitted and the offer lands after the root components', () => {
	const template = build(F.namedWithCouponAndOffer, {
		'h::text::store_name': 'Aloe & Co',
		'b::text::customer_name': 'Priya',
		'b::text::discount': '30%',
		'btn::0::copy_code': 'SUMMER30',
		'lto::expiration_time_ms': 1769000000000,
	});

	assert.deepStrictEqual(template.components, [
		{
			type: 'header',
			parameters: [{ type: 'text', text: 'Aloe & Co', parameter_name: 'store_name' }],
		},
		{
			type: 'body',
			parameters: [
				{ type: 'text', text: 'Priya', parameter_name: 'customer_name' },
				{ type: 'text', text: '30%', parameter_name: 'discount' },
			],
		},
		{
			type: 'button',
			index: '0',
			sub_type: 'copy_code',
			parameters: [{ type: 'coupon_code', coupon_code: 'SUMMER30' }],
		},
		{
			type: 'limited_time_offer',
			parameters: [
				{
					type: 'limited_time_offer',
					limited_time_offer: { expiration_time_ms: 1769000000000 },
				},
			],
		},
	]);
});

// ---------------------------------------------------------------------------
// Fixture 3 — carousel
// ---------------------------------------------------------------------------

test('fixture 3: carousel fields are scoped per card', () => {
	assert.deepStrictEqual(ids(buildFieldsFromTemplate(F.carouselTwoCards)), [
		'b::text::1',
		'card::0::h::media::image',
		'card::0::b::text::1',
		'card::0::btn::0::url::1',
		'card::1::h::media::image',
		'card::1::b::text::1',
		'card::1::btn::0::url::1',
	]);
});

test('fixture 3: card labels name the card', () => {
	const fields = buildFieldsFromTemplate(F.carouselTwoCards);
	assert.ok(labelFor(fields, 'card::1::b::text::1').startsWith('Card 2 · Body'));
});

test('fixture 3: a numeric media value serialises as { id }, cards keep their index', () => {
	const template = build(F.carouselTwoCards, {
		'b::text::1': 'Pablo',
		'card::0::h::media::image': '1558081531584829',
		'card::0::b::text::1': '20%',
		'card::0::btn::0::url::1': 'aloe',
		'card::1::h::media::image': '1558081531584830',
		'card::1::b::text::1': '15%',
		'card::1::btn::0::url::1': 'blue-elf',
	});

	assert.deepStrictEqual(template.components, [
		{ type: 'body', parameters: [{ type: 'text', text: 'Pablo' }] },
		{
			type: 'carousel',
			cards: [
				{
					card_index: 0,
					components: [
						{
							type: 'header',
							parameters: [{ type: 'image', image: { id: '1558081531584829' } }],
						},
						{ type: 'body', parameters: [{ type: 'text', text: '20%' }] },
						{
							type: 'button',
							index: '0',
							sub_type: 'url',
							parameters: [{ type: 'text', text: 'aloe' }],
						},
					],
				},
				{
					card_index: 1,
					components: [
						{
							type: 'header',
							parameters: [{ type: 'image', image: { id: '1558081531584830' } }],
						},
						{ type: 'body', parameters: [{ type: 'text', text: '15%' }] },
						{
							type: 'button',
							index: '0',
							sub_type: 'url',
							parameters: [{ type: 'text', text: 'blue-elf' }],
						},
					],
				},
			],
		},
	]);
});

// ---------------------------------------------------------------------------
// Fixture 4 — authentication, copy code
// ---------------------------------------------------------------------------

test('fixture 4: an authentication template asks for exactly one value', () => {
	assert.deepStrictEqual(ids(buildFieldsFromTemplate(F.authCopyCode)), ['auth::otp::0']);
});

test('fixture 4: one field in, the same code in body and button out', () => {
	const template = build(F.authCopyCode, { 'auth::otp::0': '482913' });

	assert.deepStrictEqual(template.components, [
		{ type: 'body', parameters: [{ type: 'text', text: '482913' }] },
		{
			type: 'button',
			sub_type: 'url',
			index: '0',
			parameters: [{ type: 'text', text: '482913' }],
		},
	]);
});

// ---------------------------------------------------------------------------
// Fixture 5 — validation
// ---------------------------------------------------------------------------

test('fixture 5: a partly filled template names the count and the short labels', () => {
	assert.throws(
		() => build(F.fourRequiredVars, { 'h::text::1': 'A-8823' }),
		(error) => {
			assert.ok(
				error.message.includes('is missing 3 required variables'),
				error.message,
			);
			assert.strictEqual(error.description, 'Fill in: body {{1}} · body {{2}} · body {{3}}');
			// Full labels run to 60+ characters each and would be unreadable here.
			assert.ok(!error.description.includes('⟨'), error.description);
			return true;
		},
	);
});

test('fixture 5: a fully filled template does not throw', () => {
	assert.doesNotThrow(() =>
		build(F.fourRequiredVars, {
			'h::text::1': 'A-8823',
			'b::text::1': 'Ravi',
			'b::text::2': '3',
			'b::text::3': 'Friday',
		}),
	);
});

// ---------------------------------------------------------------------------
// Fixture 6 — ordering
// ---------------------------------------------------------------------------

test('fixture 6: values supplied out of order serialise numerically', () => {
	const template = build(F.threeBodyVars, {
		'b::text::3': 'third',
		'b::text::1': 'first',
		'b::text::2': 'second',
	});

	assert.deepStrictEqual(template.components[0].parameters, [
		{ type: 'text', text: 'first' },
		{ type: 'text', text: 'second' },
		{ type: 'text', text: 'third' },
	]);
});

// ---------------------------------------------------------------------------
// Fixture 7 — media card carousel, verified against Meta's documentation
// ---------------------------------------------------------------------------

test('fixture 7: a quick reply inside a card is shown up front', () => {
	const fields = buildFieldsFromTemplate(F.mediaCardCarousel);
	const quickReply = fields.find((f) => f.id === 'card::0::btn::0::quick_reply_payload');

	assert.strictEqual(quickReply.removed, false);
});

test('fixture 7: matches the payload in BUILD-PLAN section 7.1', () => {
	const template = build(F.mediaCardCarousel, {
		'b::text::1': 'Pablo',
		'card::0::h::media::image': '1558081531584829',
		'card::0::btn::0::quick_reply_payload': 'more-aloes',
		'card::0::btn::1::url::1': 'blue-elf',
	});

	assert.deepStrictEqual(template.components, [
		{ type: 'body', parameters: [{ type: 'text', text: 'Pablo' }] },
		{
			type: 'carousel',
			cards: [
				{
					card_index: 0,
					components: [
						{
							type: 'header',
							parameters: [{ type: 'image', image: { id: '1558081531584829' } }],
						},
						{
							type: 'button',
							index: '0',
							sub_type: 'quick_reply',
							parameters: [{ type: 'payload', payload: 'more-aloes' }],
						},
						{
							type: 'button',
							index: '1',
							sub_type: 'url',
							parameters: [{ type: 'text', text: 'blue-elf' }],
						},
					],
				},
			],
		},
	]);
});

// ---------------------------------------------------------------------------
// Fixture 8 — MPM
// ---------------------------------------------------------------------------

test('fixture 8: MPM asks for sections, not just a thumbnail', () => {
	const fields = buildFieldsFromTemplate(F.mpmTemplate);

	assert.deepStrictEqual(ids(fields), [
		'b::text::1',
		'btn::0::mpm_sections',
		'btn::0::mpm_thumbnail',
	]);

	const sections = fields.find((f) => f.id === 'btn::0::mpm_sections');
	assert.strictEqual(sections.type, 'array');
	assert.strictEqual(sections.required, true);
});

test('fixture 8: thumbnail and sections fold into one action object', () => {
	const template = build(F.mpmTemplate, {
		'b::text::1': 'Ravi',
		'btn::0::mpm_thumbnail': 'SKU-1',
		'btn::0::mpm_sections': JSON.stringify([
			{
				title: 'Best sellers',
				product_items: [{ product_retailer_id: 'SKU-1' }, { product_retailer_id: 'SKU-2' }],
			},
		]),
	});

	assert.deepStrictEqual(template.components[1], {
		type: 'button',
		index: '0',
		sub_type: 'mpm',
		parameters: [
			{
				type: 'action',
				action: {
					thumbnail_product_retailer_id: 'SKU-1',
					sections: [
						{
							title: 'Best sellers',
							product_items: [
								{ product_retailer_id: 'SKU-1' },
								{ product_retailer_id: 'SKU-2' },
							],
						},
					],
				},
			},
		],
	});
});

// ---------------------------------------------------------------------------
// Fixture 9 — PRODUCT header
// ---------------------------------------------------------------------------

test('fixture 9: a PRODUCT header generates a field and the right parameter', () => {
	assert.deepStrictEqual(ids(buildFieldsFromTemplate(F.productHeader)), [
		'h::product::product_retailer_id',
		'h::product::catalog_id',
		'b::text::1',
	]);

	const template = build(F.productHeader, {
		'h::product::product_retailer_id': 'SKU-9',
		'b::text::1': 'Ravi',
	});

	assert.deepStrictEqual(template.components[0], {
		type: 'header',
		parameters: [{ type: 'product', product: { product_retailer_id: 'SKU-9' } }],
	});
});

// ---------------------------------------------------------------------------
// Fixture 10 — zero-tap authentication
// ---------------------------------------------------------------------------

test('fixture 10: zero-tap gets a plain auth::otp ID', () => {
	assert.deepStrictEqual(ids(buildFieldsFromTemplate(F.authZeroTapNoButton)), ['auth::otp']);
});

test('fixture 10: zero-tap emits no button component', () => {
	const template = build(F.authZeroTapNoButton, { 'auth::otp': '482913' });

	assert.deepStrictEqual(template.components, [
		{ type: 'body', parameters: [{ type: 'text', text: '482913' }] },
	]);
});

// ---------------------------------------------------------------------------
// Remaining component families
// ---------------------------------------------------------------------------

test('LOCATION headers ask for four parts, two of them required', () => {
	const fields = buildFieldsFromTemplate(F.locationHeader);

	assert.deepStrictEqual(ids(fields), [
		'h::loc::latitude',
		'h::loc::longitude',
		'h::loc::name',
		'h::loc::address',
	]);
	assert.strictEqual(fields.find((f) => f.id === 'h::loc::latitude').required, true);
	assert.strictEqual(fields.find((f) => f.id === 'h::loc::address').required, false);

	const template = build(F.locationHeader, {
		'h::loc::latitude': '19.0760',
		'h::loc::longitude': '72.8777',
		'h::loc::name': 'Bandra store',
	});

	assert.deepStrictEqual(template.components[0], {
		type: 'header',
		parameters: [
			{
				type: 'location',
				location: { latitude: '19.0760', longitude: '72.8777', name: 'Bandra store' },
			},
		],
	});
});

test('a DOCUMENT filename is consumed with its media field, never on its own', () => {
	const fields = buildFieldsFromTemplate(F.documentHeader);
	assert.deepStrictEqual(ids(fields), ['h::media::document', 'h::media_filename']);

	const template = build(F.documentHeader, {
		'h::media::document': '1558081531584829',
		'h::media_filename': 'invoice.pdf',
	});

	assert.deepStrictEqual(template.components, [
		{
			type: 'header',
			parameters: [
				{ type: 'document', document: { id: '1558081531584829', filename: 'invoice.pdf' } },
			],
		},
	]);
});

test('FLOW buttons fold token and action data into one action object', () => {
	const fields = buildFieldsFromTemplate(F.flowButton);
	assert.deepStrictEqual(ids(fields), ['btn::0::flow_token', 'btn::0::flow_action_data']);

	const template = build(F.flowButton, {
		'btn::0::flow_token': 'tok-123',
		'btn::0::flow_action_data': '{"product_id":"SKU-1"}',
	});

	assert.deepStrictEqual(template.components[0], {
		type: 'button',
		index: '0',
		sub_type: 'flow',
		parameters: [
			{
				type: 'action',
				action: { flow_token: 'tok-123', flow_action_data: { product_id: 'SKU-1' } },
			},
		],
	});
});

test('CATALOG buttons emit a thumbnail action', () => {
	const template = build(F.catalogButton, { 'btn::0::catalog_thumbnail': 'SKU-7' });

	assert.deepStrictEqual(template.components[0], {
		type: 'button',
		index: '0',
		sub_type: 'catalog',
		parameters: [{ type: 'action', action: { thumbnail_product_retailer_id: 'SKU-7' } }],
	});
});

test('an unknown component or button type degrades to no fields rather than throwing', () => {
	const fields = buildFieldsFromTemplate(F.unknownComponentType);
	assert.deepStrictEqual(ids(fields), []);

	const template = build(F.unknownComponentType, {});
	assert.deepStrictEqual(template, { name: 'future_template', language: { code: 'en_US' } });
});

// ---------------------------------------------------------------------------
// shortLabel, preview and send body
// ---------------------------------------------------------------------------

test('shortLabel stays compact for every part of the grammar', () => {
	assert.strictEqual(shortLabel('b::text::2'), 'body {{2}}');
	assert.strictEqual(shortLabel('b::text::customer_name'), 'body customer_name');
	assert.strictEqual(shortLabel('card::1::h::media::image'), 'card 2 header image');
	assert.strictEqual(shortLabel('btn::0::copy_code'), 'button 1 coupon code');
	assert.strictEqual(shortLabel('btn::2::mpm_sections'), 'button 3 product sections');
	assert.strictEqual(shortLabel('lto::expiration_time_ms'), 'offer expiry');
	assert.strictEqual(shortLabel('auth::otp::0'), 'one-time code');
});

test('renderPreview substitutes Meta’s example values', () => {
	const preview = renderPreview(F.positionalWithImageHeader);

	assert.ok(preview.includes('[IMAGE]'), preview);
	assert.ok(preview.includes('Hi Ravi, your order #A-8823 ships on Friday.'), preview);
	assert.ok(preview.includes('[ Track order ]'), preview);
	assert.ok(!preview.includes('{{'), preview);
});

// ---------------------------------------------------------------------------
// Auto-map — n8n leaves `value` null in autoMapInputData mode
// ---------------------------------------------------------------------------

test('autoMapKey translates a field ID to the name an item would use', () => {
	assert.strictEqual(autoMapKey('b::text::customer_name'), 'customer_name');
	assert.strictEqual(autoMapKey('card::1::b::text::discount'), 'discount');
	assert.strictEqual(autoMapKey('h::media::image'), 'image');
	assert.strictEqual(autoMapKey('btn::0::copy_code'), 'copy_code');
	assert.strictEqual(autoMapKey('auth::otp::0'), 'otp');
	assert.strictEqual(autoMapKey('auth::otp'), 'otp');
	assert.strictEqual(autoMapKey('lto::expiration_time_ms'), 'expiration_time_ms');
});

test('autoMapKey refuses to guess for positional variables', () => {
	// An incoming property called "1" lining up with {{1}} is a coincidence.
	assert.strictEqual(autoMapKey('b::text::1'), undefined);
	assert.strictEqual(autoMapKey('btn::0::url::1'), undefined);
});

test('auto-map fills a named variable straight from the incoming item', () => {
	const fields = buildFieldsFromTemplate(F.namedWithCouponAndOffer);
	const values = autoMapValues(fields, {
		store_name: 'Aloe & Co',
		customer_name: 'Priya',
		discount: '30%',
		copy_code: 'SUMMER30',
		expiration_time_ms: 1769000000000,
		unrelated: 'ignored',
	});

	assert.deepStrictEqual(values, {
		'h::text::store_name': 'Aloe & Co',
		'b::text::customer_name': 'Priya',
		'b::text::discount': '30%',
		'btn::0::copy_code': 'SUMMER30',
		'lto::expiration_time_ms': 1769000000000,
	});

	// And the result must survive the builder unchanged.
	const template = buildTemplateObject({
		node: fakeNode,
		itemIndex: 0,
		templateName: F.namedWithCouponAndOffer.name,
		languageCode: F.namedWithCouponAndOffer.language,
		schema: fields,
		values,
		category: F.namedWithCouponAndOffer.category,
	});

	assert.deepStrictEqual(template.components[1].parameters, [
		{ type: 'text', text: 'Priya', parameter_name: 'customer_name' },
		{ type: 'text', text: '30%', parameter_name: 'discount' },
	]);
});

test('auto-map also accepts an item already keyed by field ID', () => {
	const fields = buildFieldsFromTemplate(F.threeBodyVars);
	const values = autoMapValues(fields, { 'b::text::1': 'a', 'b::text::2': 'b' });

	assert.deepStrictEqual(values, { 'b::text::1': 'a', 'b::text::2': 'b' });
});

test('auto-map skips absent, null and removed fields', () => {
	const fields = buildFieldsFromTemplate(F.positionalWithImageHeader);
	const values = autoMapValues(fields, {
		image: 'https://cdn.example.com/a.jpg',
		quick_reply_payload: 'should-be-skipped',
		nothing: null,
	});

	// btn::1::quick_reply_payload is removed: true on a standalone template.
	assert.deepStrictEqual(values, { 'h::media::image': 'https://cdn.example.com/a.jpg' });
});

// ---------------------------------------------------------------------------
// Values that arrive as real arrays and objects, not strings
// ---------------------------------------------------------------------------

test('an array-typed field is not stringified into [object Object]', () => {
	const sections = [
		{ title: 'Best sellers', product_items: [{ product_retailer_id: 'SKU-1' }] },
	];

	const template = build(F.mpmTemplate, {
		'b::text::1': 'Ravi',
		'btn::0::mpm_sections': sections,
	});

	assert.deepStrictEqual(template.components[1].parameters[0].action.sections, sections);
});

test('an object-typed flow payload is passed through untouched', () => {
	const template = build(F.flowButton, {
		'btn::0::flow_action_data': { product_id: 'SKU-1', nested: { ok: true } },
	});

	assert.deepStrictEqual(template.components[0].parameters[0].action.flow_action_data, {
		product_id: 'SKU-1',
		nested: { ok: true },
	});
});

test('an empty array counts as an empty value', () => {
	assert.throws(
		() => build(F.mpmTemplate, { 'b::text::1': 'Ravi', 'btn::0::mpm_sections': [] }),
		/missing 1 required variable/,
	);
});

// ---------------------------------------------------------------------------
// Regressions
// ---------------------------------------------------------------------------

test('an authentication template is detected by its field even without a category', () => {
	// The schema is built from a cached template read; if that cache has expired
	// by execution time the category can arrive undefined.
	const template = buildTemplateObject({
		node: fakeNode,
		itemIndex: 0,
		templateName: 'verification_code',
		languageCode: 'en_US',
		schema: buildFieldsFromTemplate(F.authCopyCode),
		values: { 'auth::otp::0': '482913' },
		category: undefined,
	});

	assert.deepStrictEqual(template.components, [
		{ type: 'body', parameters: [{ type: 'text', text: '482913' }] },
		{
			type: 'button',
			sub_type: 'url',
			index: '0',
			parameters: [{ type: 'text', text: '482913' }],
		},
	]);
});

test('renderPreview substitutes a placeholder written with inner whitespace', () => {
	const spaced = {
		name: 'spaced',
		language: 'en_US',
		status: 'APPROVED',
		category: 'UTILITY',
		components: [
			{ type: 'BODY', text: 'Hi {{ 1 }}, welcome.', example: { body_text: [['Ravi']] } },
		],
	};

	assert.deepStrictEqual(ids(buildFieldsFromTemplate(spaced)), ['b::text::1']);
	assert.strictEqual(renderPreview(spaced), 'Hi Ravi, welcome.');
});

test('an example value containing $& is inserted literally', () => {
	const dollar = {
		name: 'dollar',
		language: 'en_US',
		status: 'APPROVED',
		category: 'UTILITY',
		components: [
			{ type: 'BODY', text: 'Total {{1}}', example: { body_text: [['$&100']] } },
		],
	};

	assert.strictEqual(renderPreview(dollar), 'Total $&100');
});

test('buildSendBody attaches MM-only fields only when they are given', () => {
	const template = { name: 'x', language: { code: 'en_US' } };

	assert.deepStrictEqual(buildSendBody('919876543210', template), {
		messaging_product: 'whatsapp',
		recipient_type: 'individual',
		to: '919876543210',
		type: 'template',
		template,
	});

	const withMm = buildSendBody('919876543210', template, {
		bizOpaqueCallbackData: 'n8n:1:0:x',
		messageActivitySharing: true,
		messageSendTtlSeconds: 43200,
	});

	assert.strictEqual(withMm.biz_opaque_callback_data, 'n8n:1:0:x');
	assert.strictEqual(withMm.message_activity_sharing, true);
	assert.strictEqual(withMm.message_send_ttl_seconds, 43200);
});

done();
