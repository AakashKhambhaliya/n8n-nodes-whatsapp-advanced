import type { IDataObject } from 'n8n-workflow';

import {
	classifyWaError,
	dispositionOf,
	explainWaError,
	parseWaError,
	retryAfterMs,
} from './errors';
import type { DeliveryEvent } from './interfaces';

/**
 * The half of the round trip that actually knows whether a message arrived.
 *
 * Pure module. Errors found here go through the same `classifyWaError` /
 * `dispositionOf` / `retryAfterMs` the send path uses, so a `131049` looks
 * identical whichever half surfaced it — which is the whole point of putting
 * webhook parsing in the same node as sending.
 */

/** Only these two mean the message reached the handset. `sent` means it left Meta. */
const DELIVERED_STATUSES = new Set(['delivered', 'read']);

function asRecord(value: unknown): IDataObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}

function asArray(value: unknown): IDataObject[] {
	return Array.isArray(value) ? (value as IDataObject[]) : [];
}

/**
 * Trigger configurations differ: some hand on the whole `whatsapp_business_account`
 * envelope, some the bare `entry.changes[].value` object. Both are accepted.
 */
function collectValues(payload: IDataObject): IDataObject[] {
	const values: IDataObject[] = [];

	const entries = asArray(payload?.entry);
	if (entries.length > 0) {
		for (const entry of entries) {
			for (const change of asArray(entry?.changes)) {
				if (change?.field !== undefined && change.field !== 'messages') continue;
				const value = asRecord(change?.value);
				if (value) values.push(value);
			}
		}
		return values;
	}

	const nested = asRecord(payload?.value);
	if (nested) return [nested];

	return [payload];
}

/**
 * Inbound-message webhooks arrive on the same `messages` field as status
 * updates. Distinguishing them by the presence of `statuses` — rather than by
 * the field name — is what stops every inbound reply being reported as a
 * delivery event.
 */
export function isStatusWebhook(payload: IDataObject): boolean {
	if (payload === null || typeof payload !== 'object') return false;

	return collectValues(payload).some(
		(value) => asArray(value?.statuses).length > 0 || asArray(value?.errors).length > 0,
	);
}

function isoFromUnixSeconds(timestamp: unknown): string | undefined {
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return new Date(seconds * 1000).toISOString();
}

function applyError(event: DeliveryEvent, rawError: IDataObject): void {
	const parsed = parseWaError(rawError);
	const cls = classifyWaError(parsed);
	const wait = retryAfterMs(parsed);

	event.code = parsed.code;
	event.title = parsed.title ?? parsed.message;
	event.reason = parsed.details ?? parsed.message;
	event.href = parsed.href;
	event.errorClass = cls;
	event.disposition = dispositionOf(cls);
	event.guidance = explainWaError(parsed);

	// An opt-out gets no retry hint, here as on the send path. Anything that
	// picks these events up and re-queues on `retryAfter` must not be handed one.
	if (wait !== undefined) {
		event.retryAfterMs = wait;
		event.retryAfter = new Date(Date.now() + wait).toISOString();
	}
}

export function parseStatusWebhook(
	payload: IDataObject,
	includeRaw = false,
): DeliveryEvent[] {
	const events: DeliveryEvent[] = [];

	for (const value of collectValues(payload)) {
		const metadata = asRecord(value?.metadata) ?? {};

		for (const status of asArray(value?.statuses)) {
			const statusName = String(status?.status ?? 'unknown');
			const conversation = asRecord(status?.conversation);
			const pricing = asRecord(status?.pricing);

			const event: DeliveryEvent = {
				delivered: DELIVERED_STATUSES.has(statusName),
				status: statusName,
				messageId: status?.id as string | undefined,
				recipient: status?.recipient_id as string | undefined,
				timestamp: isoFromUnixSeconds(status?.timestamp),
				trackingRef: status?.biz_opaque_callback_data as string | undefined,
				phoneNumberId: metadata.phone_number_id as string | undefined,
				displayPhoneNumber: metadata.display_phone_number as string | undefined,
				conversationId: conversation?.id as string | undefined,
				conversationOrigin: asRecord(conversation?.origin)?.type as string | undefined,
				pricingCategory: pricing?.category as string | undefined,
				billable: pricing?.billable as boolean | undefined,
			};

			const errors = asArray(status?.errors);
			if (errors.length > 0) applyError(event, errors[0]);

			if (includeRaw) event.raw = status;

			events.push(event);
		}

		// Account-level failures sit beside `statuses`, not inside one. They carry
		// no message ID, and dropping them loses the only notice of, say, a token
		// that expired mid-campaign.
		for (const error of asArray(value?.errors)) {
			const event: DeliveryEvent = {
				delivered: false,
				status: 'failed',
				accountLevel: true,
				phoneNumberId: metadata.phone_number_id as string | undefined,
				displayPhoneNumber: metadata.display_phone_number as string | undefined,
			};
			applyError(event, error);
			if (includeRaw) event.raw = error;
			events.push(event);
		}
	}

	return events;
}
