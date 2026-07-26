import { createHash } from 'crypto';

import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	IHttpRequestOptions,
} from 'n8n-workflow';

import { parseWaError } from '../helpers/errors';
import type {
	SendEndpoint,
	WaPhoneNumber,
	WaPhoneNumberListResponse,
	WaTemplate,
	WaTemplateListResponse,
} from '../helpers/interfaces';

export const CREDENTIALS_TYPE = 'whatsAppAdvancedApi';

/** Used only when the credential's version field is blank. */
export const DEFAULT_GRAPH_VERSION = 'v23.0';

/**
 * Meta omits `components` and `parameter_format` from the default projection on
 * some Graph versions. Without them the whole template-aware-fields feature is
 * impossible, so the projection is always explicit.
 */
export const TEMPLATE_FIELDS =
	'id,name,language,status,category,sub_category,parameter_format,components,message_send_ttl_seconds,quality_score';

/**
 * `platform_type` and `status` are what separate a number that can send from one
 * that only looks configured. A number sitting in a WABA without Cloud API
 * registration answers every send with "(#133010) Account not registered", and
 * nothing in the WABA-level credential test hints at it.
 */
export const PHONE_NUMBER_FIELDS =
	'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status,status';

const TEMPLATE_PAGE_SIZE = 200;
const MAX_PAGES = 10;
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 50;

type RequestContext = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * Graph API identifiers — WABA IDs, phone number IDs, version strings — are the
 * only parts of a request URL this node interpolates.
 *
 * The host cannot be changed through them: the authority is fixed before any of
 * this is appended, so injected text lands in the path. What it *can* do is
 * silently move the request somewhere else on graph.facebook.com — a `?` or `#`
 * truncates the path, a `/` adds a segment — and the answer comes back as an
 * opaque Meta error about a resource nobody meant to call. Rejecting the input
 * names the real problem instead.
 */
const GRAPH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function graphSegment(value: unknown, label: string): string {
	const segment = String(value ?? '').trim();

	if (!GRAPH_SEGMENT_RE.test(segment)) {
		throw new Error(
			`${label} must be a plain Graph API identifier (letters, digits, dot, dash, underscore), but got “${segment}”`,
		);
	}

	return segment;
}

export function sendUrl(phoneNumberId: string, endpoint: SendEndpoint): string {
	return `/${graphSegment(phoneNumberId, 'Sender phone number ID')}/${endpoint}`;
}

async function graphBaseUrl(this: RequestContext): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIALS_TYPE);
	const version = graphSegment(
		((credentials.graphApiVersion as string) || DEFAULT_GRAPH_VERSION).trim(),
		'Graph API version',
	);
	return `https://graph.facebook.com/${version}`;
}

/**
 * All Graph traffic goes through here. On failure the *original* error is
 * rethrown with Meta's parsed envelope attached — classification in
 * helpers/errors.ts needs the untouched payload, and wrapping in NodeApiError
 * at this depth destroys it. Wrapping happens at the call site via toNodeError.
 */
export async function waApiRequest(
	this: RequestContext,
	method: IHttpRequestMethods,
	resource: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<unknown> {
	const baseURL = await graphBaseUrl.call(this);

	const options: IHttpRequestOptions = {
		method,
		url: `${baseURL}${resource}`,
		json: true,
		headers: { 'Content-Type': 'application/json' },
	};

	if (body !== undefined) options.body = body;
	if (qs !== undefined) options.qs = qs;

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIALS_TYPE, options);
	} catch (error) {
		// Only an object can carry the annotation. Assigning a property to a
		// thrown string or number throws a TypeError under "use strict", which
		// would replace Meta's error with a meaningless one.
		if (error !== null && typeof error === 'object') {
			(error as IDataObject).waError = parseWaError(error) as unknown as IDataObject;
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Template cache
// ---------------------------------------------------------------------------

interface CacheEntry {
	at: number;
	templates: WaTemplate[];
}

/**
 * Module-level and deliberately so. The resource mapper re-reads the template
 * list on every keystroke in the picker; without this each keystroke is a Graph
 * call. TTL is short enough that a template approved a minute ago shows up.
 */
const templateCache = new Map<string, CacheEntry>();

/**
 * Entries expire by TTL but nothing deletes them, and every distinct template
 * name searched adds a key. In an n8n instance that stays up for weeks this
 * would grow without bound, so expired keys are dropped on write and the map is
 * capped in insertion order.
 */
function sweepTemplateCache(): void {
	const now = Date.now();

	for (const [key, entry] of Array.from(templateCache.entries())) {
		if (now - entry.at >= CACHE_TTL_MS) templateCache.delete(key);
	}

	// `>=`, not `>`: this runs immediately before an insert, so leaving exactly
	// MAX entries here would put the map one over the cap.
	while (templateCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = templateCache.keys().next();
		if (oldest.done) break;
		templateCache.delete(oldest.value);
	}
}

export function invalidateTemplateCache(wabaId?: string): void {
	if (wabaId === undefined) {
		templateCache.clear();
		return;
	}
	for (const key of Array.from(templateCache.keys())) {
		if (key.includes(`:${wabaId}:`)) templateCache.delete(key);
	}
}

/**
 * A short, irreversible fingerprint of the credential in use.
 *
 * The cache lives at module scope, which means it is shared by every workflow
 * and every user in one n8n process. Keyed on the business account ID alone, a
 * second tenant who merely *knows* a WABA ID would be served the first tenant's
 * cached templates — names, body copy, example values — without their own token
 * ever being checked. The fingerprint puts each credential in its own namespace.
 *
 * SHA-256, truncated, never logged and never sent anywhere. Rotating the token
 * changes the fingerprint, which correctly drops the old entries.
 */
async function credentialFingerprint(this: RequestContext): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIALS_TYPE);

	return createHash('sha256')
		.update(String(credentials.accessToken ?? ''))
		.digest('hex')
		.slice(0, 16);
}

export async function fetchTemplates(
	this: RequestContext,
	wabaId: string,
	nameFilter?: string,
): Promise<WaTemplate[]> {
	const account = graphSegment(wabaId, 'Business account ID');

	const cacheKey = `${await credentialFingerprint.call(this)}:${account}:${nameFilter ?? '*'}`;
	const cached = templateCache.get(cacheKey);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.templates;

	const templates: WaTemplate[] = [];
	let after: string | undefined;

	for (let page = 0; page < MAX_PAGES; page++) {
		const qs: IDataObject = { fields: TEMPLATE_FIELDS, limit: TEMPLATE_PAGE_SIZE };
		if (nameFilter) qs.name = nameFilter;
		if (after) qs.after = after;

		const response = (await waApiRequest.call(
			this,
			'GET',
			`/${account}/message_templates`,
			undefined,
			qs,
		)) as WaTemplateListResponse;

		templates.push(...(response?.data ?? []));

		// Stop on the absence of `paging.next`, not on a short page — Meta returns
		// fewer than `limit` rows well before the end of a large template set.
		if (!response?.paging?.next) break;
		after = response.paging.cursors?.after;
		if (!after) break;
	}

	sweepTemplateCache();
	templateCache.set(cacheKey, { at: Date.now(), templates });
	return templates;
}

/**
 * Meta's `name` query filter is a *prefix* match — asking for `order_update`
 * also returns `order_update_v2`. The exact comparison here is what stops the
 * wrong template being sent.
 */
export async function fetchTemplate(
	this: RequestContext,
	wabaId: string,
	name: string,
	language: string,
): Promise<WaTemplate | undefined> {
	const templates = await fetchTemplates.call(this, wabaId, name);
	return templates.find(
		(template) => template.name === name && template.language === language,
	);
}

export async function fetchPhoneNumbers(
	this: RequestContext,
	wabaId: string,
): Promise<WaPhoneNumber[]> {
	const account = graphSegment(wabaId, 'Business account ID');

	const response = (await waApiRequest.call(this, 'GET', `/${account}/phone_numbers`, undefined, {
		fields: PHONE_NUMBER_FIELDS,
		limit: 100,
	})) as WaPhoneNumberListResponse;

	return response?.data ?? [];
}
