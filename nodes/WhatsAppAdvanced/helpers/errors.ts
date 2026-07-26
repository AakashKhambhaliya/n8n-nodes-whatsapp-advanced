import type { INode, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

/**
 * Pure module. No `this`, no network, no n8n context beyond the `INode` handed
 * to `toNodeError` — which is why every branch below is unit-testable with
 * plain `node`.
 *
 * Every decision keys off Meta's numeric `code`. Never off message text: Meta
 * rewords strings between versions, deprecates the titles embedded in
 * `message`, and returns localised copy on non-English business accounts.
 * `error_data.details` is used only to disambiguate codes Meta reuses.
 */

export interface WaError {
	code?: number;
	details?: string;
	message: string;
	type?: string;
	fbtraceId?: string;
	httpStatus?: number;
	/** Webhook errors carry a docs link; HTTP errors do not. */
	href?: string;
	title?: string;
}

export type WaErrorClass =
	| 'auth'
	| 'integrity'
	| 'mm_fallback'
	| 'cloud_marketing_disabled'
	| 'retryable'
	| 'deferred'
	| 'opt_out'
	| 'undeliverable'
	| 'template_mismatch'
	| 'fix_required'
	| 'unknown';

export type WaDisposition =
	| 'retry_now'
	| 'retry_later'
	| 'reroute'
	| 'suppress'
	| 'fix'
	| 'unknown';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------
// Code sets
// ---------------------------------------------------------------------------

/** Transient Meta-side failures. Safe to replay immediately with backoff. */
const RETRYABLE_CODES = new Set([1, 2, 130429, 131000, 131016, 131057, 133004, 2494100]);

/**
 * Meta declined to deliver *right now*. These are not refusals — the recipient
 * never said no — so they are re-queueable rather than discarded.
 *
 * `metaStated: true` marks the two waits Meta documents. The rest are node
 * defaults: Meta describes the restriction without giving a duration.
 */
export const DEFERRED_CODES = new Map<number, { waitMs: number; metaStated: boolean }>([
	[131049, { waitMs: 24 * HOUR, metaStated: true }],
	[134101, { waitMs: 10 * MINUTE, metaStated: true }],
	[131056, { waitMs: 15 * MINUTE, metaStated: false }],
	[4, { waitMs: 15 * MINUTE, metaStated: false }],
	[80007, { waitMs: 15 * MINUTE, metaStated: false }],
	[131048, { waitMs: 24 * HOUR, metaStated: false }],
	[131064, { waitMs: 24 * HOUR, metaStated: false }],
	[133016, { waitMs: 24 * HOUR, metaStated: false }],
]);

/** The Marketing Messages API will not take this message — Cloud API might. */
const MM_FALLBACK_CODES = new Set([100, 131009, 131055, 134100, 134101, 134102]);

/**
 * Codes whose meaning flips with the endpoint, and which mean "this account is
 * not set up for the Marketing Messages API" when that is where the request
 * went.
 *
 * `133010` reads as "the phone number never completed Cloud API registration"
 * on `/messages` — a genuine fix-required — but as "the business is not
 * onboarded to MM Lite" on `/marketing_messages`, which the Cloud API will
 * happily accept instead. Classification keeps the first meaning, because that
 * is the one a user needs explained; only the fallback check knows about the
 * second.
 */
const MM_ONBOARDING_CODES = new Set([133010]);

/** Marketing templates are disabled on Cloud API. Meta's stated fix is the MM API. */
const CLOUD_MARKETING_DISABLED_CODE = 131063;

/** The recipient opted out. Suppress permanently; never retry, never replay. */
const OPT_OUT_CODE = 131050;

/** The message cannot arrive at all. Retrying changes nothing. */
const UNDELIVERABLE_CODES = new Set([130403, 131021, 131026]);

const TEMPLATE_MISMATCH_CODES = new Set([132000, 132001, 132012]);

const FIX_REQUIRED_CODES = new Set([
	131042, 131045, 131047, 132007, 132015, 132016, 132018, 133010, 134011,
]);

const AUTH_CODES = new Set([0, 3, 10, 190, 131005]);

const INTEGRITY_CODES = new Set([368, 130497, 131031]);

/**
 * Codes that must never trigger either fallback. Replaying an opt-out or a
 * blocked number on the other endpoint burns quota and delivers nothing, and in
 * the opt-out case Meta explicitly says not to.
 */
const DO_NOT_RETRY_CODES = new Set([
	OPT_OUT_CODE,
	...UNDELIVERABLE_CODES,
	...TEMPLATE_MISMATCH_CODES,
	...FIX_REQUIRED_CODES,
	...AUTH_CODES,
	...INTEGRITY_CODES,
]);

const isAuthCode = (code: number): boolean =>
	AUTH_CODES.has(code) || (code >= 200 && code <= 299);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object'
		? (value as Record<string, unknown>)
		: undefined;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return undefined;
}

/**
 * Meta's error envelope sits at a different depth depending on whether n8n's
 * HTTP helper, a `NodeApiError`, a raw axios failure or a status webhook put it
 * there. Rather than guess, walk every known location and take the first one
 * carrying a code.
 */
function findEnvelope(error: unknown): Record<string, unknown> | undefined {
	const seen = new Set<unknown>();
	const queue: unknown[] = [error];

	while (queue.length > 0) {
		const current = queue.shift();
		const record = asRecord(current);
		if (record === undefined || seen.has(record)) continue;
		seen.add(record);

		// A node carrying `code` (HTTP) or `code` + `title` (webhook) is the envelope.
		if (record.code !== undefined && toNumber(record.code) !== undefined) return record;

		// `waError` first: transport annotates failures with an already-parsed
		// envelope, and preferring it keeps a re-parse deterministic instead of
		// depending on which branch the search happens to reach first.
		for (const key of [
			'waError',
			'error',
			'cause',
			'body',
			'data',
			'response',
			'errorResponse',
		]) {
			if (record[key] !== undefined) queue.push(record[key]);
		}
	}

	return undefined;
}

export function parseWaError(error: unknown): WaError {
	const envelope = findEnvelope(error);
	const outer = asRecord(error);

	// HTTP: error_data.details. Webhook: error_data.details as well, but the
	// surrounding shape is flat and carries `title` and `href` instead of
	// `type` and `fbtrace_id`.
	const errorData = asRecord(envelope?.error_data);

	const message =
		(typeof envelope?.message === 'string' && envelope.message) ||
		(typeof envelope?.title === 'string' && envelope.title) ||
		(typeof outer?.message === 'string' && outer.message) ||
		(error instanceof Error ? error.message : undefined) ||
		'Unknown WhatsApp API error';

	const httpStatus =
		toNumber(outer?.httpCode) ??
		toNumber(outer?.statusCode) ??
		toNumber(asRecord(outer?.response)?.status) ??
		toNumber(envelope?.httpStatus);

	return {
		code: toNumber(envelope?.code),
		details:
			(typeof errorData?.details === 'string' && errorData.details) ||
			(typeof envelope?.error_user_msg === 'string' && envelope.error_user_msg) ||
			(typeof envelope?.details === 'string' && envelope.details) ||
			undefined,
		message,
		type: typeof envelope?.type === 'string' ? envelope.type : undefined,
		fbtraceId:
			(typeof envelope?.fbtrace_id === 'string' && envelope.fbtrace_id) ||
			(typeof envelope?.fbtraceId === 'string' && envelope.fbtraceId) ||
			undefined,
		httpStatus,
		href: typeof envelope?.href === 'string' ? envelope.href : undefined,
		title: typeof envelope?.title === 'string' ? envelope.title : undefined,
	};
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Order matters. `134101` is both an MM-eligibility failure and a documented
 * 10-minute wait; the eligibility reading wins because rerouting delivers the
 * message now, while deferring delays it. `100` is context-dependent —
 * "must be a template message" on the MM API, "unsupported parameter" on Cloud
 * API — so it classifies as a fallback candidate here and the *endpoint* check
 * in `shouldFallbackToCloudApi` decides whether that reading applies.
 */
export function classifyWaError(error: WaError): WaErrorClass {
	const code = error.code;
	if (code === undefined) return 'unknown';

	if (code === OPT_OUT_CODE) return 'opt_out';
	if (UNDELIVERABLE_CODES.has(code)) return 'undeliverable';
	if (isAuthCode(code)) return 'auth';
	if (INTEGRITY_CODES.has(code)) return 'integrity';
	if (code === CLOUD_MARKETING_DISABLED_CODE) return 'cloud_marketing_disabled';
	if (MM_FALLBACK_CODES.has(code)) return 'mm_fallback';
	if (DEFERRED_CODES.has(code)) return 'deferred';
	if (RETRYABLE_CODES.has(code)) return 'retryable';
	if (TEMPLATE_MISMATCH_CODES.has(code)) return 'template_mismatch';
	if (FIX_REQUIRED_CODES.has(code)) return 'fix_required';

	return 'unknown';
}

export function dispositionOf(cls: WaErrorClass): WaDisposition {
	switch (cls) {
		case 'retryable':
			return 'retry_now';
		case 'deferred':
			return 'retry_later';
		case 'mm_fallback':
		case 'cloud_marketing_disabled':
			return 'reroute';
		case 'opt_out':
		case 'undeliverable':
			return 'suppress';
		case 'template_mismatch':
		case 'fix_required':
		case 'auth':
		case 'integrity':
			return 'fix';
		default:
			return 'unknown';
	}
}

export function isRetryable(error: WaError): boolean {
	return classifyWaError(error) === 'retryable';
}

export function isDeferred(error: WaError): boolean {
	return error.code !== undefined && DEFERRED_CODES.has(error.code);
}

/**
 * How long to wait before this message is worth sending again.
 *
 * Returns `undefined` for anything that is not deferrable — most importantly
 * `131050`. An opt-out with a retry hint would be picked up by a Wait node and
 * resent, which is exactly what Meta tells you not to do.
 */
export function retryAfterMs(error: WaError): number | undefined {
	if (error.code === undefined) return undefined;
	return DEFERRED_CODES.get(error.code)?.waitMs;
}

/** True when the wait came from Meta's documentation rather than this node. */
export function isMetaStatedWait(error: WaError): boolean {
	if (error.code === undefined) return false;
	return DEFERRED_CODES.get(error.code)?.metaStated === true;
}

// ---------------------------------------------------------------------------
// Fallback direction
// ---------------------------------------------------------------------------

export function shouldFallbackToCloudApi(error: WaError, sentTo: string): boolean {
	if (sentTo !== 'marketing_messages') return false;
	if (error.code === undefined) return false;

	// Checked ahead of the do-not-retry guard on purpose. These codes classify as
	// fix-required — which is right for Cloud API — but reaching them here means
	// the request went to the MM API, where they mean "not onboarded" and the
	// Cloud API is the answer.
	if (MM_ONBOARDING_CODES.has(error.code)) return true;

	if (DO_NOT_RETRY_CODES.has(error.code)) return false;
	return MM_FALLBACK_CODES.has(error.code);
}

export function shouldFallbackToMarketingApi(error: WaError, sentTo: string): boolean {
	if (sentTo !== 'messages') return false;
	if (error.code === undefined) return false;
	if (DO_NOT_RETRY_CODES.has(error.code)) return false;
	return error.code === CLOUD_MARKETING_DISABLED_CODE;
}

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

const GUIDANCE: Record<number, string> = {
	0: 'Meta could not authenticate the request. Re-generate the system user token and update the credential.',
	1: 'Meta returned a generic API error. This is usually transient — the node retries it automatically.',
	2: 'Meta reported a temporary service failure. Retry; if it persists, check the WhatsApp Business Platform status page.',
	3: 'The access token is missing a required capability. Grant whatsapp_business_messaging and whatsapp_business_management, then re-issue it.',
	4: 'The app hit its API call rate limit. Throughput, not this message, is the problem — resend once the window clears.',
	10: 'The app lacks permission for this call. Check the token scopes and that the app is subscribed to the WhatsApp product.',
	100: 'Meta rejected a parameter. On the Marketing Messages API this usually means the message is not a template — that endpoint accepts template messages only.',
	190: 'The access token expired or was invalidated. Issue a new system user token and update the credential.',
	368: 'The account is temporarily blocked for a policy violation. Resolve it in Business Manager; retrying will not help.',
	80007: 'The business-account rate limit was hit. Slow the send rate and resend later.',
	130403: 'The recipient has blocked this business, or messaging them is not permitted. Do not resend.',
	130429: 'Meta throttled the message rate. The node backs off and retries automatically.',
	130497: 'Messaging is restricted on this account by an integrity action. Check Business Manager for the restriction.',
	131000: 'Meta reported an internal error while processing the message. Retry.',
	131005: 'The token is not authorised for this phone number. Confirm the number belongs to the business account in the credential.',
	131009: 'A parameter value is invalid for this endpoint. Check the template parameters against the approved template.',
	131016: 'The service is temporarily unavailable. Retry shortly.',
	131021: 'The sender and recipient are the same number, or the recipient cannot receive this message.',
	131026: 'The number is not a valid WhatsApp user, or cannot receive messages. Verify the number and remove it from the list.',
	131031: 'The account has been locked by an integrity review. Resolve it in Business Manager.',
	131042: 'There is a billing problem on the business account. Add or fix the payment method in Business Manager.',
	131045: 'The phone number is not registered or its certificate is missing. Complete number registration.',
	131047: 'More than 24 hours have passed since the user last replied. Only a template message can reopen the conversation.',
	131048: 'Sending is restricted on this number, usually for quality reasons. Wait for the restriction to lift before resending.',
	131049: 'Meta capped how many marketing messages this recipient receives. Meta says to wait at least 24 hours and resend — the recipient did not opt out.',
	131050: 'The recipient opted out of marketing messages from this business. Do not resend; remove them from the marketing list.',
	131055: 'The template category is not accepted on this endpoint. Send a MARKETING template, or switch to the Cloud API.',
	131056: 'Too many messages sent to this recipient in a short window. Space the sends out and resend.',
	131057: 'The account is in maintenance mode. Retry once it clears.',
	131063: 'Marketing messages are disabled on the Cloud API for this account. Send this template through the Marketing Messages API instead.',
	131064: 'The message was held by category enforcement. Confirm the template category matches its content.',
	132000: 'The number of parameters does not match the approved template. Refresh the template and refill the variables.',
	132001: 'The template name or language does not exist on this business account. Check both.',
	132007: 'The template content violates policy. Edit and resubmit it in WhatsApp Manager.',
	132012: 'A parameter value is malformed for its position in the template.',
	132015: 'The template is paused for quality reasons and cannot be sent.',
	132016: 'The template was disabled for quality reasons and cannot be sent.',
	132018: 'The template is flagged as high risk and is blocked from sending.',
	133004: 'The service is temporarily unavailable. Retry.',
	133010:
		'On the Marketing Messages API this means the business is not onboarded to it — the node falls back to the Cloud API automatically. On the Cloud API it means the sending number never completed registration: run POST /{PHONE_NUMBER_ID}/register with messaging_product "whatsapp" and a 6-digit PIN. Check too that the credential holds the Business Account ID and not a Phone Number ID; they are different values on the same API Setup page.',
	133016: 'The number was recently deleted and re-registered, so sending is briefly restricted. Retry later.',
	134011: 'The template is missing required components for this send. Re-read the template and refill the variables.',
	134100: 'This template is not eligible for the Marketing Messages API. Send it through the Cloud API.',
	134101: 'The template is still syncing to the linked ad account, which takes up to 10 minutes after approval. The node falls back to the Cloud API meanwhile.',
	134102: 'The business account is not onboarded to the Marketing Messages API. Accept the Marketing Messages Terms of Service at the business-portfolio level.',
	2494100: 'Meta returned a transient platform error. Retry.',
};

export function explainWaError(error: WaError): string | undefined {
	if (error.code === undefined) return undefined;
	if (GUIDANCE[error.code] !== undefined) return GUIDANCE[error.code];

	if (isAuthCode(error.code)) {
		return 'Authentication or permission failure. Re-issue the access token with whatsapp_business_messaging and whatsapp_business_management.';
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Surfacing
// ---------------------------------------------------------------------------

/** Exponential backoff with jitter, capped at 8 s. */
export function backoffDelayMs(attempt: number): number {
	const base = Math.min(8000, 500 * 2 ** attempt);
	return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * Wrap for display. Everything the user needs to act sits in the message and
 * description: Meta's own `details`, the next step, the endpoint that was
 * called, the template involved and the `fbtrace_id` a Meta support ticket asks
 * for first.
 */
export function toNodeError(
	node: INode,
	error: unknown,
	ctx: { itemIndex?: number; endpoint?: string; templateName?: string } = {},
): Error {
	const parsed = parseWaError(error);
	const cls = classifyWaError(parsed);

	const headline = parsed.code !== undefined ? `WhatsApp error ${parsed.code}` : 'WhatsApp error';
	const message = parsed.details ? `${headline}: ${parsed.details}` : `${headline}: ${parsed.message}`;

	const lines: string[] = [];
	const guidance = explainWaError(parsed);
	if (guidance) lines.push(guidance);
	if (ctx.templateName) lines.push(`Template: ${ctx.templateName}`);
	if (ctx.endpoint) lines.push(`Endpoint: ${ctx.endpoint}`);
	lines.push(`Class: ${cls} · disposition: ${dispositionOf(cls)}`);
	if (parsed.fbtraceId) lines.push(`fbtrace_id: ${parsed.fbtraceId}`);

	// Rebuilt from the parsed fields rather than forwarded.
	//
	// A failed HTTP request carries the whole request context with it, and that
	// includes `config.headers.Authorization: Bearer <access token>`. Handing the
	// raw error to NodeApiError would put the token inside an object n8n stores
	// on the execution and renders in the UI. Today NodeApiError happens to
	// discard it, but `n8n-workflow` is a `*` peer dependency — that is a
	// behaviour to design against, not to rely on.
	const safeEnvelope: JsonObject = {
		error: {
			message: parsed.message,
			...(parsed.type !== undefined ? { type: parsed.type } : {}),
			...(parsed.code !== undefined ? { code: parsed.code } : {}),
			...(parsed.details !== undefined ? { error_data: { details: parsed.details } } : {}),
			...(parsed.fbtraceId !== undefined ? { fbtrace_id: parsed.fbtraceId } : {}),
		},
	};

	const wrapped = new NodeApiError(node, safeEnvelope, {
		message,
		description: lines.join(' · '),
		itemIndex: ctx.itemIndex,
		httpCode: parsed.httpStatus !== undefined ? String(parsed.httpStatus) : undefined,
	});

	// NodeApiError keeps the rendered message and throws the envelope away — it
	// sets neither `cause` nor `errorResponse`. Re-parsing the wrapper would then
	// yield no code, which is exactly what `continueOnFail` needs to emit. So the
	// parsed error rides along, and `findEnvelope` looks at `waError` first.
	(wrapped as unknown as Record<string, unknown>).waError = parsed;

	return wrapped;
}
