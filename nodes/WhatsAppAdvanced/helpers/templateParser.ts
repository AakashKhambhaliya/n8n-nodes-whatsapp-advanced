import type { ResourceMapperField } from 'n8n-workflow';

import type {
	ParsedPlaceholder,
	WaComponentExample,
	WaTemplate,
	WaTemplateButton,
	WaTemplateComponent,
} from './interfaces';

/**
 * FEATURE 1a. Pure module: template in, resource-mapper fields out.
 *
 * At execution time n8n hands the node the stored schema plus the user's values
 * and nothing else — not the template, not the component the value came from.
 * So every fact the payload builder needs is encoded into the field ID. That is
 * what keeps the builder network-free: a campaign of 50 000 messages does one
 * cached template lookup, not 50 000.
 */

export const SEP = '::';

/**
 * Meta requires named parameters to be lowercase letters, digits and
 * underscores, and never all-digits. So this single test decides whether the
 * emitted parameter carries `parameter_name`.
 */
export function isPositionalKey(key: string): boolean {
	return /^\d+$/.test(key);
}

const PLACEHOLDER_SOURCE = '\\{\\{\\s*([A-Za-z0-9_]+)\\s*\\}\\}';

/**
 * Every `{{…}}` in the approved copy, de-duplicated. A template may well repeat
 * `{{1}}` — Meta still expects exactly one value for it, so only the first
 * occurrence becomes a field.
 */
export function extractPlaceholders(text?: string): ParsedPlaceholder[] {
	if (!text) return [];

	const found: ParsedPlaceholder[] = [];
	const seen = new Set<string>();

	// A fresh instance per call. A shared /g regex carries `lastIndex` between
	// calls, which turns any accidental re-entry into silently missing fields.
	const pattern = new RegExp(PLACEHOLDER_SOURCE, 'g');
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const key = match[1];
		if (seen.has(key)) continue;
		seen.add(key);
		found.push({ key, start: match.index, end: match.index + match[0].length });
	}

	return found;
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A window of the approved copy around one variable, so the field heading shows
 * where the value lands. The target is rendered as `⟨key⟩` while its neighbours
 * stay as `{{…}}` — without that, a body with four variables gives four
 * identical-looking headings.
 */
export function contextSnippet(
	text: string,
	placeholder: ParsedPlaceholder,
	radius = 24,
): string {
	const before = text.slice(Math.max(0, placeholder.start - radius), placeholder.start);
	const after = text.slice(placeholder.end, placeholder.end + radius);

	const leadingCut = placeholder.start - radius > 0;
	const trailingCut = placeholder.end + radius < text.length;

	return [
		leadingCut ? '…' : '',
		flatten(before),
		`⟨${placeholder.key}⟩`,
		flatten(after),
		trailingCut ? '…' : '',
	]
		.filter((part) => part !== '')
		.join(' ')
		.replace(/\s+/g, ' ')
		.replace(/… /g, '…')
		.replace(/ …/g, '…')
		.trim();
}

/**
 * Meta ships three different example shapes — a flat array for header text, an
 * array *of arrays* for body text, and an array of `{ param_name, example }`
 * for named parameters. All three are normalised here so nothing downstream has
 * to know which one it is looking at.
 */
export function exampleFor(
	component: WaTemplateComponent,
	placeholder: ParsedPlaceholder,
	slot: 'header' | 'body',
	ordinal: number,
): string | undefined {
	const example = component.example as WaComponentExample | undefined;
	if (!example) return undefined;

	const named =
		slot === 'header' ? example.header_text_named_params : example.body_text_named_params;

	if (Array.isArray(named)) {
		const hit = named.find((entry) => entry?.param_name === placeholder.key);
		if (hit?.example !== undefined) return String(hit.example);
	}

	if (slot === 'header' && Array.isArray(example.header_text)) {
		const value = example.header_text[ordinal];
		if (value !== undefined) return String(value);
	}

	if (slot === 'body' && Array.isArray(example.body_text)) {
		const row = example.body_text[0];
		if (Array.isArray(row) && row[ordinal] !== undefined) return String(row[ordinal]);
	}

	return undefined;
}

function variableLabel(key: string): string {
	return isPositionalKey(key) ? `{{${key}}}` : key;
}

/** `{Component} · {variable}  ·  {snippet}  (e.g. {example})` */
function composeLabel(parts: {
	component: string;
	variable?: string;
	snippet?: string;
	example?: string;
	cardIndex?: number;
}): string {
	const head = parts.cardIndex === undefined ? parts.component : `Card ${parts.cardIndex + 1} · ${parts.component}`;

	const segments = [head];
	if (parts.variable) segments.push(parts.variable);
	if (parts.snippet) segments.push(parts.snippet);

	const label = segments.join(' · ');
	return parts.example ? `${label}  (e.g. ${parts.example})` : label;
}

interface FieldOpts {
	id: string;
	displayName: string;
	required?: boolean;
	removed?: boolean;
	type?: ResourceMapperField['type'];
}

function field(opts: FieldOpts): ResourceMapperField {
	return {
		id: opts.id,
		displayName: opts.displayName,
		required: opts.required ?? true,
		defaultMatch: false,
		canBeUsedToMatch: false,
		display: true,
		removed: opts.removed ?? false,
		type: opts.type ?? 'string',
	};
}

const MEDIA_FORMATS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);

const prefixed = (cardIndex: number | undefined, id: string): string =>
	cardIndex === undefined ? id : `card${SEP}${cardIndex}${SEP}${id}`;

// ---------------------------------------------------------------------------
// Per-component field generation
// ---------------------------------------------------------------------------

function headerFields(
	component: WaTemplateComponent,
	cardIndex: number | undefined,
): ResourceMapperField[] {
	const format = (component.format ?? 'TEXT').toUpperCase();
	const fields: ResourceMapperField[] = [];

	if (format === 'TEXT') {
		extractPlaceholders(component.text).forEach((placeholder, ordinal) => {
			fields.push(
				field({
					id: prefixed(cardIndex, `h${SEP}text${SEP}${placeholder.key}`),
					displayName: composeLabel({
						component: 'Header',
						variable: variableLabel(placeholder.key),
						snippet: contextSnippet(component.text ?? '', placeholder),
						example: exampleFor(component, placeholder, 'header', ordinal),
						cardIndex,
					}),
				}),
			);
		});
		return fields;
	}

	if (MEDIA_FORMATS.has(format)) {
		const kind = format.toLowerCase();
		fields.push(
			field({
				id: prefixed(cardIndex, `h${SEP}media${SEP}${kind}`),
				displayName: composeLabel({
					component: `Header · ${kind}`,
					snippet: 'public URL or uploaded media ID',
					cardIndex,
				}),
			}),
		);

		if (format === 'DOCUMENT') {
			fields.push(
				field({
					id: prefixed(cardIndex, `h${SEP}media_filename`),
					displayName: composeLabel({
						component: 'Header · document',
						snippet: 'filename shown to the recipient',
						cardIndex,
					}),
					required: false,
					removed: true,
				}),
			);
		}
		return fields;
	}

	if (format === 'LOCATION') {
		const parts: Array<[string, string, boolean]> = [
			['latitude', 'latitude', true],
			['longitude', 'longitude', true],
			['name', 'place name', false],
			['address', 'street address', false],
		];
		for (const [key, hint, required] of parts) {
			fields.push(
				field({
					id: prefixed(cardIndex, `h${SEP}loc${SEP}${key}`),
					displayName: composeLabel({
						component: 'Header · location',
						snippet: hint,
						cardIndex,
					}),
					required,
					removed: !required,
				}),
			);
		}
		return fields;
	}

	if (format === 'PRODUCT') {
		fields.push(
			field({
				id: prefixed(cardIndex, `h${SEP}product${SEP}product_retailer_id`),
				displayName: composeLabel({
					component: 'Header · product',
					snippet: 'product retailer ID',
					cardIndex,
				}),
			}),
			field({
				id: prefixed(cardIndex, `h${SEP}product${SEP}catalog_id`),
				displayName: composeLabel({
					component: 'Header · product',
					snippet: 'catalog ID (defaults to the connected catalog)',
					cardIndex,
				}),
				required: false,
				removed: true,
			}),
		);
		return fields;
	}

	// Unknown header format: generate nothing rather than throwing, so a
	// template using a format Meta ships next still sends via the escape hatch.
	return fields;
}

function bodyFields(
	component: WaTemplateComponent,
	cardIndex: number | undefined,
): ResourceMapperField[] {
	return extractPlaceholders(component.text).map((placeholder, ordinal) =>
		field({
			id: prefixed(cardIndex, `b${SEP}text${SEP}${placeholder.key}`),
			displayName: composeLabel({
				component: 'Body',
				variable: variableLabel(placeholder.key),
				snippet: contextSnippet(component.text ?? '', placeholder),
				example: exampleFor(component, placeholder, 'body', ordinal),
				cardIndex,
			}),
		}),
	);
}

function buttonExample(button: WaTemplateButton): string | undefined {
	if (Array.isArray(button.example)) return button.example[0] as string | undefined;
	if (typeof button.example === 'string') return button.example;
	return undefined;
}

function buttonFields(
	component: WaTemplateComponent,
	cardIndex: number | undefined,
): ResourceMapperField[] {
	const fields: ResourceMapperField[] = [];

	(component.buttons ?? []).forEach((button, index) => {
		const type = String(button.type ?? '').toUpperCase();
		const name = `Button ${index + 1}${button.text ? ` "${button.text}"` : ''}`;

		if (type === 'URL') {
			// Only a *dynamic* URL takes a parameter. A static URL button sends no
			// component at all, so asking for a value would be a lie.
			const placeholders = extractPlaceholders(button.url);
			for (const placeholder of placeholders) {
				fields.push(
					field({
						id: prefixed(cardIndex, `btn${SEP}${index}${SEP}url${SEP}${placeholder.key}`),
						displayName: composeLabel({
							component: name,
							variable: `URL suffix ⟨${placeholder.key}⟩`,
							snippet: button.url,
							example: buttonExample(button),
							cardIndex,
						}),
					}),
				);
			}
			return;
		}

		if (type === 'QUICK_REPLY') {
			// The postback payload is optional. Meta's carousel documentation puts
			// one on every card, so inside a card it is shown up front; on a
			// standalone template it stays behind "Add variable".
			fields.push(
				field({
					id: prefixed(cardIndex, `btn${SEP}${index}${SEP}quick_reply_payload`),
					displayName: composeLabel({
						component: name,
						variable: 'quick reply payload',
						snippet: 'returned on the WhatsApp Trigger when tapped',
						cardIndex,
					}),
					required: false,
					removed: cardIndex === undefined,
				}),
			);
			return;
		}

		if (type === 'COPY_CODE') {
			fields.push(
				field({
					id: prefixed(cardIndex, `btn${SEP}${index}${SEP}copy_code`),
					displayName: composeLabel({
						component: name,
						variable: 'coupon code',
						example: buttonExample(button),
						cardIndex,
					}),
				}),
			);
			return;
		}

		if (type === 'FLOW') {
			fields.push(
				field({
					id: prefixed(cardIndex, `btn${SEP}${index}${SEP}flow_token`),
					displayName: composeLabel({
						component: name,
						variable: 'flow token',
						snippet: 'echoed back on the Flow response',
						cardIndex,
					}),
					required: false,
					removed: true,
				}),
				field({
					id: prefixed(cardIndex, `btn${SEP}${index}${SEP}flow_action_data`),
					displayName: composeLabel({
						component: name,
						variable: 'flow action data',
						snippet: 'JSON passed into the first Flow screen',
						cardIndex,
					}),
					required: false,
					removed: true,
					type: 'object',
				}),
			);
			return;
		}

		if (type === 'CATALOG') {
			fields.push(
				field({
					id: prefixed(cardIndex, `btn${SEP}${index}${SEP}catalog_thumbnail`),
					displayName: composeLabel({
						component: name,
						variable: 'thumbnail product retailer ID',
						cardIndex,
					}),
					required: false,
					removed: true,
				}),
			);
			return;
		}

		if (type === 'MPM') {
			// `sections` is the actual content of a multi-product message; a
			// thumbnail alone sends an empty product list.
			fields.push(
				field({
					id: prefixed(cardIndex, `btn${SEP}${index}${SEP}mpm_sections`),
					displayName: composeLabel({
						component: name,
						variable: 'product sections',
						snippet: 'JSON array of { title, product_items: [{ product_retailer_id }] }',
						cardIndex,
					}),
					type: 'array',
				}),
				field({
					id: prefixed(cardIndex, `btn${SEP}${index}${SEP}mpm_thumbnail`),
					displayName: composeLabel({
						component: name,
						variable: 'thumbnail product retailer ID',
						cardIndex,
					}),
					required: false,
					removed: true,
				}),
			);
			return;
		}

		// PHONE_NUMBER, VOICE_CALL, OTP and anything Meta ships next take no
		// send-time parameters.
	});

	return fields;
}

function componentFields(
	component: WaTemplateComponent,
	cardIndex: number | undefined,
): ResourceMapperField[] {
	switch (String(component.type ?? '').toUpperCase()) {
		case 'HEADER':
			return headerFields(component, cardIndex);
		case 'BODY':
			return bodyFields(component, cardIndex);
		case 'BUTTONS':
			return buttonFields(component, cardIndex);
		default:
			// FOOTER takes no parameters; unknown component types degrade to none.
			return [];
	}
}

// ---------------------------------------------------------------------------
// Authentication templates
// ---------------------------------------------------------------------------

function otpButtonIndex(template: WaTemplate): number | undefined {
	for (const component of template.components ?? []) {
		if (String(component.type ?? '').toUpperCase() !== 'BUTTONS') continue;
		const index = (component.buttons ?? []).findIndex(
			(button) => String(button.type ?? '').toUpperCase() === 'OTP',
		);
		if (index >= 0) return index;
	}
	return undefined;
}

/**
 * Authentication templates have no user-authored variables — Meta fixes the
 * copy and the only value is the code. It goes in two places at once (body and,
 * for copy-code and one-tap, the button), so the node asks once and fans it out.
 *
 * Zero-tap declares no OTP button. Encoding the button index in the field ID is
 * what lets the payload builder know whether to emit the button component
 * without re-reading the template.
 */
function authenticationFields(template: WaTemplate): ResourceMapperField[] {
	const index = otpButtonIndex(template);
	const id = index === undefined ? `auth${SEP}otp` : `auth${SEP}otp${SEP}${index}`;

	return [
		field({
			id,
			displayName: composeLabel({
				component: 'Authentication',
				variable: 'one-time code',
				snippet:
					index === undefined
						? 'sent in the message body (this template declares no OTP button)'
						: 'sent in the message body and the copy/autofill button',
				example: '482913',
			}),
		}),
	];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildFieldsFromTemplate(template: WaTemplate): ResourceMapperField[] {
	if (String(template.category ?? '').toUpperCase() === 'AUTHENTICATION') {
		return authenticationFields(template);
	}

	const fields: ResourceMapperField[] = [];

	for (const component of template.components ?? []) {
		const type = String(component.type ?? '').toUpperCase();

		if (type === 'CAROUSEL') {
			(component.cards ?? []).forEach((card, cardIndex) => {
				for (const cardComponent of card.components ?? []) {
					fields.push(...componentFields(cardComponent, cardIndex));
				}
			});
			continue;
		}

		if (type === 'LIMITED_TIME_OFFER') {
			if (component.limited_time_offer?.has_expiration) {
				fields.push(
					field({
						id: `lto${SEP}expiration_time_ms`,
						displayName: composeLabel({
							component: 'Limited-time offer',
							variable: 'expiry',
							snippet: 'Unix timestamp in milliseconds',
						}),
						type: 'number',
					}),
				);
			}
			continue;
		}

		fields.push(...componentFields(component, undefined));
	}

	return fields;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function renderComponentText(component: WaTemplateComponent, slot: 'header' | 'body'): string {
	const text = component.text ?? '';
	let rendered = text;

	extractPlaceholders(text).forEach((placeholder, ordinal) => {
		const example = exampleFor(component, placeholder, slot, ordinal);
		if (example === undefined) return;

		// Matched by pattern, not by literal `{{key}}`: Meta accepts internal
		// whitespace, and a template written as `{{ 1 }}` would otherwise show up
		// in the preview unsubstituted. The replacer is a function so that `$&`
		// and friends inside an example value stay literal.
		const pattern = new RegExp(`\\{\\{\\s*${placeholder.key}\\s*\\}\\}`, 'g');
		rendered = rendered.replace(pattern, () => example);
	});

	return rendered;
}

/** The approved copy with Meta's own example values substituted in. */
export function renderPreview(template: WaTemplate): string {
	const lines: string[] = [];

	const renderComponent = (component: WaTemplateComponent, indent = ''): void => {
		const type = String(component.type ?? '').toUpperCase();
		const format = String(component.format ?? 'TEXT').toUpperCase();

		if (type === 'HEADER') {
			if (format === 'TEXT') lines.push(indent + renderComponentText(component, 'header'));
			else lines.push(`${indent}[${format}]`);
			return;
		}

		if (type === 'BODY') {
			lines.push(indent + renderComponentText(component, 'body'));
			return;
		}

		if (type === 'FOOTER') {
			if (component.text) lines.push(indent + component.text);
			return;
		}

		if (type === 'BUTTONS') {
			for (const button of component.buttons ?? []) {
				lines.push(`${indent}[ ${button.text ?? String(button.type)} ]`);
			}
			return;
		}

		if (type === 'CAROUSEL') {
			(component.cards ?? []).forEach((card, index) => {
				lines.push(`${indent}— Card ${index + 1} —`);
				for (const cardComponent of card.components ?? []) {
					renderComponent(cardComponent, `${indent}  `);
				}
			});
		}
	};

	for (const component of template.components ?? []) renderComponent(component);

	return lines.filter((line) => line.trim() !== '').join('\n');
}
