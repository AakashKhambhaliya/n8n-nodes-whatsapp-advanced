import type { IDataObject } from 'n8n-workflow';

import type { NormalizedSend } from './interfaces';

/** Meta caps `biz_opaque_callback_data` at 512 characters. */
const MAX_TRACKING_REF = 512;

/**
 * The join key between a send and the status webhook that eventually reports
 * its outcome. Meta echoes `biz_opaque_callback_data` back unchanged, and once
 * a workflow fans out across recipients it is the only reliable way to match
 * the two halves — message IDs are not known to the rest of the workflow until
 * the send returns, by which point the branch has moved on.
 *
 * A user-supplied value is respected untouched; their downstream system may
 * already key off it.
 */
export function buildTrackingRef(
	userValue: string | undefined,
	ctx: { executionId?: string; itemIndex: number; templateName?: string },
): string | undefined {
	if (userValue !== undefined && String(userValue).trim() !== '') {
		return String(userValue).slice(0, MAX_TRACKING_REF);
	}

	const parts = ['n8n', ctx.executionId ?? 'no-exec', String(ctx.itemIndex)];
	if (ctx.templateName) parts.push(ctx.templateName);

	return parts.join(':').slice(0, MAX_TRACKING_REF);
}

export interface NormalizeContext {
	endpoint: string;
	routedVia: string;
	templateName?: string;
	languageCode?: string;
	category?: string;
	trackingRef?: string;
	includeRaw?: boolean;
}

/**
 * Both endpoints answer a successful send with `message_status: "accepted"`,
 * which means queued and nothing more. `delivered` is therefore hard-coded
 * false here: only a status webhook can ever set it true. Meta's own status
 * string is kept verbatim rather than mapped, so a value this node has not seen
 * before still surfaces intact.
 */
export function normalizeSendResponse(
	response: IDataObject,
	ctx: NormalizeContext,
): NormalizedSend {
	const messages = Array.isArray(response?.messages)
		? (response.messages as IDataObject[])
		: [];
	const contacts = Array.isArray(response?.contacts)
		? (response.contacts as IDataObject[])
		: [];

	const first = messages[0] ?? {};
	const contact = contacts[0] ?? {};

	const normalized: NormalizedSend = {
		delivered: false,
		status: (first.message_status as string) ?? 'accepted',
		messageId: first.id as string | undefined,
		recipient: {
			input: contact.input as string | undefined,
			waId: contact.wa_id as string | undefined,
		},
		endpoint: ctx.endpoint,
		routedVia: ctx.routedVia,
		template: {
			name: ctx.templateName,
			language: ctx.languageCode,
			category: ctx.category,
		},
		trackingRef: ctx.trackingRef,
		sentAt: new Date().toISOString(),
	};

	if (ctx.includeRaw) normalized.raw = response;

	return normalized;
}
