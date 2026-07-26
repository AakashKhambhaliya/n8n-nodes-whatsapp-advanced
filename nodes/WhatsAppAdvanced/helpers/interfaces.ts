import type { IDataObject } from 'n8n-workflow';

// ---------------------------------------------------------------------------
// Template read shape — models Meta's GET /{WABA_ID}/message_templates
// ---------------------------------------------------------------------------

export type TemplateStatus =
	| 'APPROVED'
	| 'PENDING'
	| 'REJECTED'
	| 'PAUSED'
	| 'DISABLED'
	| 'IN_APPEAL'
	| 'PENDING_DELETION'
	| string;

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | string;

/**
 * `| string` throughout: Meta adds header formats and button types faster than
 * this package can be republished, and an unmodelled one must degrade to "no
 * fields generated" rather than break compilation or throw at runtime.
 */
export type HeaderFormat =
	| 'TEXT'
	| 'IMAGE'
	| 'VIDEO'
	| 'DOCUMENT'
	| 'LOCATION'
	| 'PRODUCT'
	| string;

export type ButtonType =
	| 'URL'
	| 'QUICK_REPLY'
	| 'COPY_CODE'
	| 'FLOW'
	| 'OTP'
	| 'CATALOG'
	| 'MPM'
	| 'PHONE_NUMBER'
	| 'VOICE_CALL'
	| 'SPM'
	| string;

export type ComponentType =
	| 'HEADER'
	| 'BODY'
	| 'FOOTER'
	| 'BUTTONS'
	| 'CAROUSEL'
	| 'LIMITED_TIME_OFFER'
	| string;

export type ParameterFormat = 'POSITIONAL' | 'NAMED' | string;

/** One named parameter example: `{ param_name, example }`. */
export interface WaNamedParamExample {
	param_name: string;
	example: string;
}

/**
 * Meta ships three different example shapes depending on the component and the
 * template's parameter_format. All three are normalised in one place —
 * `exampleFor()` in templateParser.ts.
 */
export interface WaComponentExample {
	/** HEADER TEXT, positional: a flat array of one value. */
	header_text?: string[];
	/** HEADER TEXT, named. */
	header_text_named_params?: WaNamedParamExample[];
	/** Media headers: an uploaded handle or a preview URL. */
	header_handle?: string[];
	/** BODY, positional: an array *of arrays*. */
	body_text?: string[][];
	/** BODY, named. */
	body_text_named_params?: WaNamedParamExample[];
	[key: string]: unknown;
}

export interface WaTemplateButton {
	type: ButtonType;
	text?: string;
	url?: string;
	phone_number?: string;
	/** URL buttons: `['suffix']`. COPY_CODE: a bare string. */
	example?: string[] | string;
	otp_type?: 'COPY_CODE' | 'ONE_TAP' | 'ZERO_TAP' | string;
	flow_id?: string;
	flow_name?: string;
	flow_action?: string;
	navigate_screen?: string;
	autofill_text?: string;
	package_name?: string;
	signature_hash?: string;
	[key: string]: unknown;
}

export interface WaTemplateComponent {
	type: ComponentType;
	format?: HeaderFormat;
	text?: string;
	example?: WaComponentExample;
	buttons?: WaTemplateButton[];
	cards?: WaTemplateCard[];
	limited_time_offer?: { text?: string; has_expiration?: boolean };
	add_security_recommendation?: boolean;
	code_expiration_minutes?: number;
	[key: string]: unknown;
}

export interface WaTemplateCard {
	components?: WaTemplateComponent[];
	[key: string]: unknown;
}

export interface WaTemplate {
	id?: string;
	name: string;
	language: string;
	status?: TemplateStatus;
	category?: TemplateCategory;
	sub_category?: string;
	/** Absent means POSITIONAL. */
	parameter_format?: ParameterFormat;
	components?: WaTemplateComponent[];
	message_send_ttl_seconds?: number;
	quality_score?: { score?: string; date?: number };
	[key: string]: unknown;
}

export interface WaTemplateListResponse {
	data?: WaTemplate[];
	paging?: {
		cursors?: { before?: string; after?: string };
		next?: string;
	};
}

export interface WaPhoneNumber {
	id: string;
	display_phone_number?: string;
	verified_name?: string;
	quality_rating?: string;
	/** `CLOUD_API` is the only value this node can send from. */
	platform_type?: 'CLOUD_API' | 'ON_PREMISE' | 'NOT_APPLICABLE' | string;
	code_verification_status?: 'VERIFIED' | 'NOT_VERIFIED' | 'EXPIRED' | string;
	status?: string;
	[key: string]: unknown;
}

export interface WaPhoneNumberListResponse {
	data?: WaPhoneNumber[];
	paging?: { cursors?: { after?: string }; next?: string };
}

// ---------------------------------------------------------------------------
// Send side
// ---------------------------------------------------------------------------

export type SendEndpoint = 'messages' | 'marketing_messages';
export type EndpointChoice = SendEndpoint | 'auto';

export interface TemplateSendOptions {
	bizOpaqueCallbackData?: string;
	recipientType?: string;
	/** MM API only. Never attach these to /messages. */
	messageActivitySharing?: boolean;
	messageSendTtlSeconds?: number;
}

/** One `{{…}}` occurrence with its position in the approved copy. */
export interface ParsedPlaceholder {
	key: string;
	start: number;
	end: number;
}

// ---------------------------------------------------------------------------
// Normalised outputs
// ---------------------------------------------------------------------------

export interface NormalizedSend {
	/** Always false on a send. Only a status webhook can set this true. */
	delivered: false;
	/** Meta's own `message_status`, kept verbatim. */
	status: string;
	messageId?: string;
	recipient?: { input?: string; waId?: string };
	endpoint: string;
	routedVia: string;
	template?: { name?: string; language?: string; category?: string };
	trackingRef?: string;
	sentAt: string;
	raw?: IDataObject;
}

export type DeliveryStatus =
	| 'accepted'
	| 'sent'
	| 'delivered'
	| 'read'
	| 'failed'
	| 'deleted'
	| string;

export interface DeliveryEvent {
	/** True only for `delivered` and `read`. `sent` means it left Meta. */
	delivered: boolean;
	status: DeliveryStatus;
	messageId?: string;
	recipient?: string;
	timestamp?: string;
	trackingRef?: string;
	phoneNumberId?: string;
	displayPhoneNumber?: string;
	conversationId?: string;
	conversationOrigin?: string;
	pricingCategory?: string;
	billable?: boolean;
	code?: number;
	title?: string;
	reason?: string;
	href?: string;
	errorClass?: string;
	disposition?: string;
	retryAfterMs?: number;
	retryAfter?: string;
	guidance?: string;
	/** Set on account-level errors that sit beside `statuses`. */
	accountLevel?: boolean;
	raw?: IDataObject;
}
