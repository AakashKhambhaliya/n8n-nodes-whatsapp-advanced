'use strict';

/**
 * The ten template fixtures from BUILD-PLAN.md section 7.0. Shapes match Meta's
 * `GET /{WABA_ID}/message_templates` response exactly, including the three
 * different `example` shapes.
 */

// 1 — POSITIONAL, IMAGE header, 3 body vars, dynamic URL button, static QUICK_REPLY
const positionalWithImageHeader = {
	id: '1',
	name: 'order_update',
	language: 'en_US',
	status: 'APPROVED',
	category: 'UTILITY',
	parameter_format: 'POSITIONAL',
	components: [
		{
			type: 'HEADER',
			format: 'IMAGE',
			example: { header_handle: ['https://scontent.example.com/preview.jpg'] },
		},
		{
			type: 'BODY',
			text: 'Hi {{1}}, your order #{{2}} ships on {{3}}. Thanks for shopping with us.',
			example: { body_text: [['Ravi', 'A-8823', 'Friday']] },
		},
		{ type: 'FOOTER', text: 'Reply STOP to opt out' },
		{
			type: 'BUTTONS',
			buttons: [
				{
					type: 'URL',
					text: 'Track order',
					url: 'https://shop.example.com/track/{{1}}',
					example: ['A-8823'],
				},
				{ type: 'QUICK_REPLY', text: 'Contact support' },
			],
		},
	],
};

// 2 — NAMED, TEXT header, coupon button, limited-time offer
const namedWithCouponAndOffer = {
	id: '2',
	name: 'summer_sale',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'NAMED',
	components: [
		{
			type: 'HEADER',
			format: 'TEXT',
			text: '{{store_name}} summer sale',
			example: {
				header_text_named_params: [{ param_name: 'store_name', example: 'Aloe & Co' }],
			},
		},
		{
			type: 'BODY',
			text: 'Hi {{customer_name}}, take {{discount}} off everything until midnight.',
			example: {
				body_text_named_params: [
					{ param_name: 'customer_name', example: 'Priya' },
					{ param_name: 'discount', example: '30%' },
				],
			},
		},
		{
			type: 'LIMITED_TIME_OFFER',
			limited_time_offer: { text: 'Expiring offer', has_expiration: true },
		},
		{
			type: 'BUTTONS',
			buttons: [
				{ type: 'COPY_CODE', text: 'Copy code', example: 'SUMMER30' },
				{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com' },
			],
		},
	],
};

// 3 — Carousel, 2 cards, per-card header + body + URL button
const carouselTwoCards = {
	id: '3',
	name: 'product_carousel',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'POSITIONAL',
	components: [
		{
			type: 'BODY',
			text: 'Hi {{1}}, these just landed.',
			example: { body_text: [['Pablo']] },
		},
		{
			type: 'CAROUSEL',
			cards: [
				{
					components: [
						{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aG…'] } },
						{
							type: 'BODY',
							text: 'Aloe vera, {{1}} off',
							example: { body_text: [['20%']] },
						},
						{
							type: 'BUTTONS',
							buttons: [
								{
									type: 'URL',
									text: 'Buy',
									url: 'https://shop.example.com/p/{{1}}',
									example: ['aloe'],
								},
							],
						},
					],
				},
				{
					components: [
						{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aG…'] } },
						{
							type: 'BODY',
							text: 'Blue elf, {{1}} off',
							example: { body_text: [['15%']] },
						},
						{
							type: 'BUTTONS',
							buttons: [
								{
									type: 'URL',
									text: 'Buy',
									url: 'https://shop.example.com/p/{{1}}',
									example: ['blue-elf'],
								},
							],
						},
					],
				},
			],
		},
	],
};

// 4 — AUTHENTICATION with a COPY_CODE OTP button
const authCopyCode = {
	id: '4',
	name: 'verification_code',
	language: 'en_US',
	status: 'APPROVED',
	category: 'AUTHENTICATION',
	components: [
		{ type: 'BODY', add_security_recommendation: true },
		{ type: 'FOOTER', code_expiration_minutes: 10 },
		{
			type: 'BUTTONS',
			buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
		},
	],
};

// 5 — Validation failure: four required vars, only one filled
const fourRequiredVars = {
	id: '5',
	name: 'shipment_notice',
	language: 'en_US',
	status: 'APPROVED',
	category: 'UTILITY',
	parameter_format: 'POSITIONAL',
	components: [
		{
			type: 'HEADER',
			format: 'TEXT',
			text: 'Shipment {{1}}',
			example: { header_text: ['A-8823'] },
		},
		{
			type: 'BODY',
			text: 'Hi {{1}}, {{2}} items ship on {{3}}.',
			example: { body_text: [['Ravi', '3', 'Friday']] },
		},
	],
};

// 6 — Ordering: three body vars supplied out of order
const threeBodyVars = {
	id: '6',
	name: 'ordering_check',
	language: 'en_US',
	status: 'APPROVED',
	category: 'UTILITY',
	parameter_format: 'POSITIONAL',
	components: [
		{
			type: 'BODY',
			text: '{{1}} {{2}} {{3}}',
			example: { body_text: [['a', 'b', 'c']] },
		},
	],
};

// 7 — Media card carousel with QUICK_REPLY + URL per card
const mediaCardCarousel = {
	id: '7',
	name: 'media_card_carousel',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'POSITIONAL',
	components: [
		{
			type: 'BODY',
			text: 'Hi {{1}}, our new arrivals.',
			example: { body_text: [['Pablo']] },
		},
		{
			type: 'CAROUSEL',
			cards: [
				{
					components: [
						{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aG…'] } },
						{ type: 'BODY', text: 'Aloe vera' },
						{
							type: 'BUTTONS',
							buttons: [
								{ type: 'QUICK_REPLY', text: 'More aloes' },
								{
									type: 'URL',
									text: 'Buy',
									url: 'https://shop.example.com/p/{{1}}',
									example: ['blue-elf'],
								},
							],
						},
					],
				},
			],
		},
	],
};

// 8 — MPM template with thumbnail + sections
const mpmTemplate = {
	id: '8',
	name: 'catalogue_drop',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'POSITIONAL',
	components: [
		{
			type: 'BODY',
			text: 'Hi {{1}}, this week’s picks.',
			example: { body_text: [['Ravi']] },
		},
		{ type: 'BUTTONS', buttons: [{ type: 'MPM', text: 'View items' }] },
	],
};

// 9 — PRODUCT header
const productHeader = {
	id: '9',
	name: 'single_product',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'POSITIONAL',
	components: [
		{ type: 'HEADER', format: 'PRODUCT' },
		{
			type: 'BODY',
			text: 'Hi {{1}}, back in stock.',
			example: { body_text: [['Ravi']] },
		},
	],
};

// 10 — Zero-tap AUTHENTICATION with no OTP button declared
const authZeroTapNoButton = {
	id: '10',
	name: 'zero_tap_code',
	language: 'en_US',
	status: 'APPROVED',
	category: 'AUTHENTICATION',
	components: [
		{ type: 'BODY', add_security_recommendation: true },
		{ type: 'FOOTER', code_expiration_minutes: 10 },
	],
};

// Extras used by targeted assertions
const locationHeader = {
	id: '11',
	name: 'store_pickup',
	language: 'en_US',
	status: 'APPROVED',
	category: 'UTILITY',
	parameter_format: 'POSITIONAL',
	components: [
		{ type: 'HEADER', format: 'LOCATION' },
		{ type: 'BODY', text: 'Ready for pickup.' },
	],
};

const documentHeader = {
	id: '12',
	name: 'invoice_ready',
	language: 'en_US',
	status: 'APPROVED',
	category: 'UTILITY',
	parameter_format: 'POSITIONAL',
	components: [
		{ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['4::aG…'] } },
		{ type: 'BODY', text: 'Your invoice is attached.' },
	],
};

const flowButton = {
	id: '13',
	name: 'book_appointment',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'POSITIONAL',
	components: [
		{ type: 'BODY', text: 'Book a slot.' },
		{
			type: 'BUTTONS',
			buttons: [{ type: 'FLOW', text: 'Book now', flow_id: '1234', flow_name: 'booking' }],
		},
	],
};

const catalogButton = {
	id: '14',
	name: 'browse_catalog',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'POSITIONAL',
	components: [
		{ type: 'BODY', text: 'Browse the catalogue.' },
		{ type: 'BUTTONS', buttons: [{ type: 'CATALOG', text: 'View catalog' }] },
	],
};

const unknownComponentType = {
	id: '15',
	name: 'future_template',
	language: 'en_US',
	status: 'APPROVED',
	category: 'MARKETING',
	parameter_format: 'POSITIONAL',
	components: [
		{ type: 'BODY', text: 'Hello.' },
		{ type: 'SOMETHING_META_SHIPS_NEXT_YEAR', payload: {} },
		{ type: 'BUTTONS', buttons: [{ type: 'VOICE_CALL', text: 'Call us' }] },
	],
};

const repeatedPlaceholder = {
	id: '16',
	name: 'repeated_var',
	language: 'en_US',
	status: 'APPROVED',
	category: 'UTILITY',
	parameter_format: 'POSITIONAL',
	components: [
		{
			type: 'BODY',
			text: 'Hi {{1}}, we mean it {{1}}.',
			example: { body_text: [['Ravi']] },
		},
	],
};

module.exports = {
	positionalWithImageHeader,
	namedWithCouponAndOffer,
	carouselTwoCards,
	authCopyCode,
	fourRequiredVars,
	threeBodyVars,
	mediaCardCarousel,
	mpmTemplate,
	productHeader,
	authZeroTapNoButton,
	locationHeader,
	documentHeader,
	flowButton,
	catalogButton,
	unknownComponentType,
	repeatedPlaceholder,
};
