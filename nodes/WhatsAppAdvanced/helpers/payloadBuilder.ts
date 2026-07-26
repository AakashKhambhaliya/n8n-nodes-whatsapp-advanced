import type { IDataObject, INode, ResourceMapperField } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { SEP, isPositionalKey } from './templateParser';
import type { TemplateSendOptions } from './interfaces';

/**
 * FEATURE 1b. Pure module, and — the point of the whole field-ID grammar — it
 * makes zero network calls. Everything it needs about the template is already
 * encoded in the IDs the parser generated.
 */

/**
 * n8n hands `object` and `array` mapper fields through as real values, not as
 * strings, so this cannot be narrowed to a scalar without mangling them.
 */
type MapperValue = unknown;

export function sanitizePhoneNumber(phone: string): string {
	return String(phone ?? '').replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// Field IDs
// ---------------------------------------------------------------------------

export interface ParsedId {
	/** Present when the field belongs to a carousel card. */
	cardIndex?: number;
	parts: string[];
}

export function parseId(id: string): ParsedId {
	const parts = id.split(SEP);

	if (parts[0] === 'card' && parts.length > 2) {
		const cardIndex = Number(parts[1]);
		if (Number.isInteger(cardIndex)) {
			return { cardIndex, parts: parts.slice(2) };
		}
	}

	return { parts };
}

/**
 * A compact name for error messages. The full field labels carry the
 * surrounding template copy and an example value — useful in the form, far too
 * long in a list of four missing variables.
 */
export function shortLabel(id: string): string {
	const { cardIndex, parts } = parseId(id);
	const prefix = cardIndex === undefined ? '' : `card ${cardIndex + 1} `;

	const variable = (key: string): string => (isPositionalKey(key) ? `{{${key}}}` : key);

	const [head, ...rest] = parts;

	if (head === 'h') {
		if (rest[0] === 'text') return `${prefix}header ${variable(rest[1])}`;
		if (rest[0] === 'media') return `${prefix}header ${rest[1]}`;
		if (rest[0] === 'media_filename') return `${prefix}header filename`;
		if (rest[0] === 'loc') return `${prefix}header location ${rest[1]}`;
		if (rest[0] === 'product') return `${prefix}header product ${rest[1]}`;
	}

	if (head === 'b' && rest[0] === 'text') return `${prefix}body ${variable(rest[1])}`;

	if (head === 'btn') {
		const number = Number(rest[0]) + 1;
		const kind = rest[1];
		const names: Record<string, string> = {
			url: 'URL suffix',
			quick_reply_payload: 'payload',
			copy_code: 'coupon code',
			flow_token: 'flow token',
			flow_action_data: 'flow data',
			catalog_thumbnail: 'thumbnail',
			mpm_thumbnail: 'thumbnail',
			mpm_sections: 'product sections',
		};
		return `${prefix}button ${number} ${names[kind] ?? kind}`;
	}

	if (head === 'lto') return 'offer expiry';
	if (head === 'auth') return 'one-time code';

	return id;
}

/**
 * The property name an incoming item would plausibly use for this field.
 *
 * Auto-map matches on field ID, and no upstream system produces
 * `b::text::customer_name` — it produces `customer_name`. Without this
 * translation "Map Automatically" matches nothing at all.
 *
 * Positional variables are deliberately excluded: an incoming property called
 * `1` lining up with `{{1}}` would be a coincidence, not a mapping, and
 * silently sending the wrong value is worse than asking for it.
 */
export function autoMapKey(id: string): string | undefined {
	const { parts } = parseId(id);
	if (parts[0] === 'auth') return 'otp';

	const last = parts[parts.length - 1];
	if (last === undefined || isPositionalKey(last)) return undefined;
	return last;
}

/**
 * Resolve a resource mapper's `autoMapInputData` mode against one input item.
 *
 * n8n leaves `value` null in that mode and expects the node to do this itself —
 * nothing fills it in on the way through.
 */
export function autoMapValues(
	schema: ResourceMapperField[],
	itemJson: Record<string, unknown>,
): Record<string, MapperValue> {
	const values: Record<string, MapperValue> = {};
	const item = itemJson ?? {};

	for (const field of schema) {
		if (field.removed === true) continue;

		const natural = autoMapKey(field.id);
		const candidates = natural === undefined ? [field.id] : [field.id, natural];

		for (const key of candidates) {
			if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
			if (item[key] === undefined || item[key] === null) continue;
			values[field.id] = item[key];
			break;
		}
	}

	return values;
}

// ---------------------------------------------------------------------------
// Parameter shapes
// ---------------------------------------------------------------------------

/**
 * One field accepts both a public URL and an already-uploaded media ID. Meta
 * distinguishes them by key, not by any flag, so the value's shape decides.
 */
export function mediaObject(value: string, filename?: string): IDataObject {
	const media: IDataObject = /^https?:\/\//i.test(value) ? { link: value } : { id: value };
	if (filename) media.filename = filename;
	return media;
}

/** `parameter_name` is emitted only for named parameters. Sending it on a positional template is rejected. */
export function textParameter(key: string, value: string): IDataObject {
	const parameter: IDataObject = { type: 'text', text: value };
	if (!isPositionalKey(key)) parameter.parameter_name = key;
	return parameter;
}

/**
 * Numeric order for positional keys, insertion order for named ones. Without
 * this a user who fills `{{3}}` before `{{1}}` gets their values transposed —
 * Meta matches body parameters by array position, not by name.
 */
export function sortPositional<T>(entries: Array<[string, T]>): Array<[string, T]> {
	return entries.slice().sort((a, b) => {
		const aPositional = isPositionalKey(a[0]);
		const bPositional = isPositionalKey(b[0]);
		if (aPositional && bPositional) return Number(a[0]) - Number(b[0]);
		if (aPositional) return -1;
		if (bPositional) return 1;
		return 0;
	});
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

interface ButtonBucket {
	url: Array<[string, string]>;
	payload?: string;
	couponCode?: string;
	flowToken?: string;
	flowActionData?: unknown;
	catalogThumbnail?: string;
	mpmThumbnail?: string;
	mpmSections?: unknown;
}

interface Bucket {
	headerText: Array<[string, string]>;
	headerMedia?: { kind: string; value: string; filename?: string };
	headerLocation: Record<string, string>;
	headerProduct: Record<string, string>;
	bodyText: Array<[string, string]>;
	buttons: Map<number, ButtonBucket>;
}

const newBucket = (): Bucket => ({
	headerText: [],
	headerLocation: {},
	headerProduct: {},
	bodyText: [],
	buttons: new Map(),
});

const buttonBucket = (bucket: Bucket, index: number): ButtonBucket => {
	let existing = bucket.buttons.get(index);
	if (existing === undefined) {
		existing = { url: [] };
		bucket.buttons.set(index, existing);
	}
	return existing;
};

/**
 * Fields declared `array` or `object` come back from n8n as real arrays and
 * objects; fields the user typed into come back as strings. Stringifying the
 * first kind turns a product list into `"[object Object]"`, so only a string is
 * ever parsed — and a string that is not JSON stays a string.
 */
function coerceJson(raw: unknown): unknown {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw !== 'string') return raw;

	const trimmed = raw.trim();
	if (trimmed === '') return undefined;
	if (!/^[[{]/.test(trimmed)) return raw;

	try {
		return JSON.parse(trimmed);
	} catch {
		return raw;
	}
}

function bucketToComponents(bucket: Bucket): IDataObject[] {
	const components: IDataObject[] = [];

	// Header: media, then location, then product, then sorted text. Meta accepts
	// exactly one header parameter, so at most one of these ever fires.
	const headerParameters: IDataObject[] = [];

	if (bucket.headerMedia) {
		const { kind, value, filename } = bucket.headerMedia;
		headerParameters.push({
			type: kind,
			[kind]: mediaObject(value, kind === 'document' ? filename : undefined),
		});
	} else if (Object.keys(bucket.headerLocation).length > 0) {
		headerParameters.push({ type: 'location', location: { ...bucket.headerLocation } });
	} else if (Object.keys(bucket.headerProduct).length > 0) {
		headerParameters.push({ type: 'product', product: { ...bucket.headerProduct } });
	} else if (bucket.headerText.length > 0) {
		for (const [key, value] of sortPositional(bucket.headerText)) {
			headerParameters.push(textParameter(key, value));
		}
	}

	if (headerParameters.length > 0) {
		components.push({ type: 'header', parameters: headerParameters });
	}

	if (bucket.bodyText.length > 0) {
		components.push({
			type: 'body',
			parameters: sortPositional(bucket.bodyText).map(([key, value]) =>
				textParameter(key, value),
			),
		});
	}

	const indexes = Array.from(bucket.buttons.keys()).sort((a, b) => a - b);
	for (const index of indexes) {
		const button = bucket.buttons.get(index) as ButtonBucket;
		const base = { type: 'button', index: String(index) };

		if (button.url.length > 0) {
			components.push({
				...base,
				sub_type: 'url',
				parameters: sortPositional(button.url).map(([, value]) => ({
					type: 'text',
					text: value,
				})),
			});
		}

		if (button.payload !== undefined) {
			components.push({
				...base,
				sub_type: 'quick_reply',
				parameters: [{ type: 'payload', payload: button.payload }],
			});
		}

		if (button.couponCode !== undefined) {
			components.push({
				...base,
				sub_type: 'copy_code',
				parameters: [{ type: 'coupon_code', coupon_code: button.couponCode }],
			});
		}

		// Flow, catalog and MPM all carry a single `action` object. Their pieces
		// arrive as separate fields and are folded back together here.
		if (button.flowToken !== undefined || button.flowActionData !== undefined) {
			const action: IDataObject = {};
			if (button.flowToken !== undefined) action.flow_token = button.flowToken;
			if (button.flowActionData !== undefined) {
				action.flow_action_data = button.flowActionData as IDataObject;
			}
			components.push({
				...base,
				sub_type: 'flow',
				parameters: [{ type: 'action', action }],
			});
		}

		if (button.catalogThumbnail !== undefined) {
			components.push({
				...base,
				sub_type: 'catalog',
				parameters: [
					{
						type: 'action',
						action: { thumbnail_product_retailer_id: button.catalogThumbnail },
					},
				],
			});
		}

		if (button.mpmSections !== undefined || button.mpmThumbnail !== undefined) {
			const action: IDataObject = {};
			if (button.mpmThumbnail !== undefined) {
				action.thumbnail_product_retailer_id = button.mpmThumbnail;
			}
			if (button.mpmSections !== undefined) action.sections = button.mpmSections as IDataObject[];
			components.push({
				...base,
				sub_type: 'mpm',
				parameters: [{ type: 'action', action }],
			});
		}
	}

	return components;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isEmpty = (value: MapperValue): boolean => {
	if (value === undefined || value === null) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value as object).length === 0;
	return String(value).trim() === '';
};

export interface BuildTemplateArgs {
	node: INode;
	itemIndex: number;
	templateName: string;
	languageCode: string;
	schema: ResourceMapperField[];
	values: Record<string, MapperValue>;
	category?: string;
}

export function buildTemplateObject(args: BuildTemplateArgs): IDataObject {
	const { schema, values, templateName, languageCode } = args;

	// Validation first. Meta's answer to a missing variable is
	// "(#132000) Number of parameters does not match", minutes into a run and
	// naming nothing — so the node names them instead.
	const missing = schema
		.filter((f) => f.required && f.display !== false && f.removed !== true)
		.filter((f) => isEmpty(values[f.id]))
		.map((f) => shortLabel(f.id));

	if (missing.length > 0) {
		throw new NodeOperationError(
			args.node,
			`Template “${templateName}” is missing ${missing.length} required variable${
				missing.length === 1 ? '' : 's'
			}`,
			{
				itemIndex: args.itemIndex,
				description: `Fill in: ${missing.join(' · ')}`,
			},
		);
	}

	const template: IDataObject = {
		name: templateName,
		language: { code: languageCode },
	};

	// Authentication short-circuit. One code, two places, and no button at all
	// when the template is zero-tap.
	//
	// The presence of an `auth::otp` field counts as well as the category: the
	// schema is built from a cached template read, and if that cache has since
	// expired the category can arrive undefined while the fields are still an
	// authentication template's.
	const authEntry = Object.entries(values).find(([id]) => id.startsWith(`auth${SEP}otp`));

	if (String(args.category ?? '').toUpperCase() === 'AUTHENTICATION' || authEntry !== undefined) {
		if (authEntry === undefined || isEmpty(authEntry[1])) return template;

		const [id, raw] = authEntry;
		const code = String(raw);
		const components: IDataObject[] = [
			{ type: 'body', parameters: [{ type: 'text', text: code }] },
		];

		// `auth::otp::0` carries a button index; plain `auth::otp` does not, which
		// is how zero-tap templates avoid emitting a button component.
		const parts = id.split(SEP);
		if (parts.length === 3 && Number.isInteger(Number(parts[2]))) {
			components.push({
				type: 'button',
				// `url` for copy-code *and* one-tap — Meta uses the same sub_type for both.
				sub_type: 'url',
				index: String(Number(parts[2])),
				parameters: [{ type: 'text', text: code }],
			});
		}

		template.components = components;
		return template;
	}

	const root = newBucket();
	const cards = new Map<number, Bucket>();
	let ltoExpiry: number | undefined;

	const bucketFor = (cardIndex?: number): Bucket => {
		if (cardIndex === undefined) return root;
		let bucket = cards.get(cardIndex);
		if (bucket === undefined) {
			bucket = newBucket();
			cards.set(cardIndex, bucket);
		}
		return bucket;
	};

	for (const [id, rawValue] of Object.entries(values)) {
		if (isEmpty(rawValue)) continue;

		const { cardIndex, parts } = parseId(id);
		const [head, ...rest] = parts;
		const value = String(rawValue);
		const bucket = bucketFor(cardIndex);

		if (head === 'h') {
			if (rest[0] === 'text') {
				bucket.headerText.push([rest[1], value]);
			} else if (rest[0] === 'media') {
				// The filename is consumed with its media field, not on its own pass.
				const filenameId =
					cardIndex === undefined
						? `h${SEP}media_filename`
						: `card${SEP}${cardIndex}${SEP}h${SEP}media_filename`;
				const filename = values[filenameId];
				bucket.headerMedia = {
					kind: rest[1],
					value,
					filename: isEmpty(filename) ? undefined : String(filename),
				};
			} else if (rest[0] === 'loc') {
				bucket.headerLocation[rest[1]] = value;
			} else if (rest[0] === 'product') {
				bucket.headerProduct[rest[1]] = value;
			}
			// `h::media_filename` alone is skipped here by design.
			continue;
		}

		if (head === 'b' && rest[0] === 'text') {
			bucket.bodyText.push([rest[1], value]);
			continue;
		}

		if (head === 'btn') {
			const index = Number(rest[0]);
			if (!Number.isInteger(index)) continue;
			const button = buttonBucket(bucket, index);

			switch (rest[1]) {
				case 'url':
					button.url.push([rest[2] ?? '1', value]);
					break;
				case 'quick_reply_payload':
					button.payload = value;
					break;
				case 'copy_code':
					button.couponCode = value;
					break;
				case 'flow_token':
					button.flowToken = value;
					break;
				case 'flow_action_data':
					button.flowActionData = coerceJson(rawValue);
					break;
				case 'catalog_thumbnail':
					button.catalogThumbnail = value;
					break;
				case 'mpm_thumbnail':
					button.mpmThumbnail = value;
					break;
				case 'mpm_sections':
					button.mpmSections = coerceJson(rawValue);
					break;
				default:
					break;
			}
			continue;
		}

		if (head === 'lto' && rest[0] === 'expiration_time_ms') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) ltoExpiry = parsed;
			continue;
		}
	}

	const components = bucketToComponents(root);

	if (ltoExpiry !== undefined) {
		components.push({
			type: 'limited_time_offer',
			parameters: [
				{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: ltoExpiry } },
			],
		});
	}

	if (cards.size > 0) {
		components.push({
			type: 'carousel',
			cards: Array.from(cards.keys())
				.sort((a, b) => a - b)
				.map((cardIndex) => ({
					card_index: cardIndex,
					components: bucketToComponents(cards.get(cardIndex) as Bucket),
				})),
		});
	}

	if (components.length > 0) template.components = components;

	return template;
}

export function buildSendBody(
	to: string,
	template: IDataObject,
	options: TemplateSendOptions = {},
): IDataObject {
	const body: IDataObject = {
		messaging_product: 'whatsapp',
		recipient_type: options.recipientType ?? 'individual',
		to,
		type: 'template',
		template,
	};

	if (options.bizOpaqueCallbackData !== undefined) {
		body.biz_opaque_callback_data = options.bizOpaqueCallbackData;
	}

	// MM-API-only fields. `/messages` either ignores or rejects them, so they are
	// attached only when the caller resolved to the Marketing Messages API.
	if (options.messageActivitySharing !== undefined) {
		body.message_activity_sharing = options.messageActivitySharing;
	}
	if (options.messageSendTtlSeconds !== undefined) {
		body.message_send_ttl_seconds = options.messageSendTtlSeconds;
	}

	return body;
}
