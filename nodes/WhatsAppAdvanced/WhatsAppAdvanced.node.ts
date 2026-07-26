import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ResourceMapperField,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { properties } from './descriptions';
import {
	autoMapValues,
	buildSendBody,
	buildTemplateObject,
	sanitizePhoneNumber,
} from './helpers/payloadBuilder';
import type { EndpointChoice, SendEndpoint, TemplateSendOptions } from './helpers/interfaces';
import { buildFieldsFromTemplate, renderPreview } from './helpers/templateParser';
import { buildTrackingRef, normalizeSendResponse } from './helpers/response';
import { isStatusWebhook, parseStatusWebhook } from './helpers/webhook';
import { listSearch, loadOptions, resourceMapping, splitTemplateValue } from './methods';
import {
	backoffDelayMs,
	classifyWaError,
	dispositionOf,
	explainWaError,
	isDeferred,
	isRetryable,
	parseWaError,
	retryAfterMs,
	shouldFallbackToCloudApi,
	shouldFallbackToMarketingApi,
	toNodeError,
} from './helpers/errors';
import { CREDENTIALS_TYPE, fetchTemplate, fetchTemplates, sendUrl, waApiRequest } from './transport';

export class WhatsAppAdvanced implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'WhatsApp Advanced',
		name: 'whatsAppAdvanced',
		icon: 'file:whatsapp.svg',
		group: ['output'],
		version: 1,
		subtitle:
			'={{ $parameter["operation"] === "sendTemplate" ? "template: " + ($parameter["template"].value || "—") : $parameter["resource"] + ": " + $parameter["operation"] }}',
		description: 'Send WhatsApp templates with variables resolved from the template itself',
		defaults: { name: 'WhatsApp Advanced' },
		usableAsTool: true,
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: CREDENTIALS_TYPE,
				required: true,
				// Parsing a status webhook is pure local work — demanding an access
				// token to classify a payload the trigger already received would be
				// a fake requirement.
				displayOptions: { show: { resource: ['message', 'template'] } },
			},
		],
		properties,
	};

	methods = { listSearch, loadOptions, resourceMapping };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Read lazily for the same reason the credential is hidden on the status
		// resource: that path never talks to Meta.
		let wabaId = '';
		if (resource !== 'status') {
			const credentials = await this.getCredentials(CREDENTIALS_TYPE);
			wabaId = credentials.businessAccountId as string;
		}

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: IDataObject | IDataObject[];

				if (resource === 'status') {
					responseData = handleStatusResource.call(this, i);
				} else if (resource === 'template') {
					responseData = await handleTemplateResource.call(this, operation, wabaId, i);
				} else if (operation === 'sendText') {
					responseData = await sendText.call(this, i);
				} else {
					responseData = await sendTemplate.call(this, wabaId, i);
				}

				const asArray = Array.isArray(responseData) ? responseData : [responseData];
				returnData.push(
					...asArray.map((json) => ({ json, pairedItem: { item: i } })),
				);
			} catch (error) {
				const parsed = parseWaError(error);

				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: parsed.message,
							code: parsed.code,
							details: parsed.details,
							errorClass: classifyWaError(parsed),
							disposition: dispositionOf(classifyWaError(parsed)),
							retryAfterMs: retryAfterMs(parsed),
							guidance: explainWaError(parsed),
							fbtraceId: parsed.fbtraceId,
						},
						pairedItem: { item: i },
					});
					continue;
				}

				// NodeApiError and NodeOperationError are siblings, not subclasses,
				// so both have to be named here. Wrapping an already-wrapped error
				// buries Meta's message one level deeper for no gain.
				if (error instanceof NodeOperationError || error instanceof NodeApiError) throw error;
				throw toNodeError(this.getNode(), error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

// ---------------------------------------------------------------------------
// Delivery status resource
// ---------------------------------------------------------------------------

/**
 * Both send endpoints are fire-and-accept: a 200 carrying `message_status:
 * "accepted"` means queued, nothing more. Delivery outcomes — and the error
 * codes that explain failures — arrive later on the `messages` webhook. This
 * operation turns that webhook into classified events using the same code
 * mapping the send path uses, so a failure looks identical whichever half of
 * the round trip surfaced it.
 */
function handleStatusResource(this: IExecuteFunctions, itemIndex: number): IDataObject[] {
	const options = this.getNodeParameter('statusOptions', itemIndex, {}) as IDataObject;

	const rawPayload = this.getNodeParameter('webhookPayload', itemIndex, {}) as
		| IDataObject
		| string;

	let payload: IDataObject;
	try {
		payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
	} catch (error) {
		throw new NodeOperationError(this.getNode(), 'Webhook payload is not valid JSON', {
			itemIndex,
			description: (error as Error).message,
		});
	}

	if (!isStatusWebhook(payload)) {
		// Inbound-message webhooks share the same field, so this is normal
		// traffic rather than an error.
		if (options.suppressEmpty !== false) return [];
		return [{ _noStatuses: true }];
	}

	let events = parseStatusWebhook(payload, options.includeRaw === true);
	if (options.onlyFailures === true) events = events.filter((event) => event.status === 'failed');

	return events as unknown as IDataObject[];
}

// ---------------------------------------------------------------------------
// Template resource
// ---------------------------------------------------------------------------

async function handleTemplateResource(
	this: IExecuteFunctions,
	operation: string,
	wabaId: string,
	itemIndex: number,
): Promise<IDataObject | IDataObject[]> {
	if (operation === 'get') {
		const raw = this.getNodeParameter('template', itemIndex, '', {
			extractValue: true,
		}) as string;
		const { name, language } = splitTemplateValue(raw);

		const template = await fetchTemplate.call(this as never, wabaId, name, language);
		if (!template) {
			throw new NodeOperationError(
				this.getNode(),
				`No template named “${name}” in language “${language}” on this business account`,
				{ itemIndex },
			);
		}

		const fields = buildFieldsFromTemplate(template);
		return {
			...(template as unknown as IDataObject),
			renderedPreview: renderPreview(template),
			variables: fields.map((f) => ({
				id: f.id,
				label: f.displayName,
				required: f.required,
			})),
		};
	}

	// list
	const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
	const templates = await fetchTemplates.call(this as never, wabaId);

	return templates
		.filter((template) => {
			if (filters.category && template.category !== filters.category) return false;
			if (filters.status && template.status !== filters.status) return false;
			if (filters.language && template.language !== filters.language) return false;
			return true;
		})
		.map((template) => ({
			...(template as unknown as IDataObject),
			variableCount: buildFieldsFromTemplate(template).length,
		}));
}

// ---------------------------------------------------------------------------
// Message resource
// ---------------------------------------------------------------------------

async function sendText(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const phoneNumberId = this.getNodeParameter('phoneNumberId', itemIndex) as string;
	const to = sanitizePhoneNumber(
		this.getNodeParameter('recipientPhoneNumber', itemIndex) as string,
	);
	const text = this.getNodeParameter('textBody', itemIndex) as string;
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

	const body: IDataObject = {
		messaging_product: 'whatsapp',
		recipient_type: 'individual',
		to,
		type: 'text',
		text: { body: text },
	};
	if (options.bizOpaqueCallbackData) {
		body.biz_opaque_callback_data = options.bizOpaqueCallbackData;
	}

	// Free-form text is never valid on the Marketing Messages API (code 100,
	// "Message must be a template message"), so this always goes to Cloud API.
	try {
		return (await waApiRequest.call(
			this as never,
			'POST',
			sendUrl(phoneNumberId, 'messages'),
			body,
		)) as IDataObject;
	} catch (error) {
		throw toNodeError(this.getNode(), error, {
			itemIndex,
			endpoint: `POST /${phoneNumberId}/messages`,
		});
	}
}

/**
 * Decide which endpoint a template send lands on.
 *
 *   auto               → MARKETING to the MM API, everything else to Cloud API
 *   messages           → always Cloud API
 *   marketing_messages → always MM API, and reject non-marketing templates
 *                        before the request leaves n8n
 */
function resolveEndpoint(
	choice: EndpointChoice,
	category: string | undefined,
	node: IExecuteFunctions,
	itemIndex: number,
): SendEndpoint {
	if (choice === 'auto') {
		return category === 'MARKETING' ? 'marketing_messages' : 'messages';
	}

	if (choice === 'marketing_messages' && category && category !== 'MARKETING') {
		throw new NodeOperationError(
			node.getNode(),
			`The Marketing Messages API only accepts MARKETING templates, but this template is ${category}`,
			{
				itemIndex,
				description:
					'Switch "Send Via" to Cloud API or Auto, or pick a marketing template.',
			},
		);
	}

	return choice;
}

async function sendTemplate(
	this: IExecuteFunctions,
	wabaId: string,
	itemIndex: number,
): Promise<IDataObject> {
	const phoneNumberId = this.getNodeParameter('phoneNumberId', itemIndex) as string;
	const to = sanitizePhoneNumber(
		this.getNodeParameter('recipientPhoneNumber', itemIndex) as string,
	);
	const endpointChoice = this.getNodeParameter(
		'messagingEndpoint',
		itemIndex,
		'auto',
	) as EndpointChoice;
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

	const raw = this.getNodeParameter('template', itemIndex, '', {
		extractValue: true,
	}) as string;
	const { name, language } = splitTemplateValue(raw);

	if (!name || !language) {
		throw new NodeOperationError(this.getNode(), 'No template selected', { itemIndex });
	}

	const mapper = this.getNodeParameter('templateParameters', itemIndex, {
		value: {},
		schema: [],
	}) as ResourceMapperValue;

	const schema = (mapper.schema ?? []) as ResourceMapperField[];

	// In "Map Automatically" mode n8n leaves `value` null and expects the node to
	// resolve the incoming item itself — nothing fills it in on the way through.
	const values =
		mapper.mappingMode === 'autoMapInputData'
			? autoMapValues(schema, this.getInputData()[itemIndex]?.json ?? {})
			: ((mapper.value ?? {}) as Record<string, unknown>);

	// The template's category decides routing. It is cached, so this costs a
	// network call only once a minute per business account.
	const template = await fetchTemplate.call(this as never, wabaId, name, language);

	if (!template) {
		throw new NodeOperationError(
			this.getNode(),
			`No template named “${name}” in language “${language}” on this business account`,
			{
				itemIndex,
				description:
					'Check the name and the language code. Meta answers this with (#132001) after the send, which names neither.',
			},
		);
	}

	const category = template.category;

	if (template.status !== 'APPROVED') {
		throw new NodeOperationError(
			this.getNode(),
			`Template “${name}” is ${template.status}, not APPROVED — Meta will reject this send`,
			{ itemIndex },
		);
	}

	const endpoint = resolveEndpoint(endpointChoice, category, this, itemIndex);

	const templateObject = buildTemplateObject({
		node: this.getNode(),
		itemIndex,
		templateName: name,
		languageCode: language,
		schema,
		values,
		category,
	});

	// Escape hatches for template families the parser does not model (payment
	// order-details / order-status templates, and anything Meta ships next).
	const parseJson = (raw: unknown, label: string): IDataObject[] | undefined => {
		if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
		let parsed: unknown;
		try {
			parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				`${label} must be a JSON array of component objects`,
				{ itemIndex, description: (error as Error).message },
			);
		}

		if (!Array.isArray(parsed)) {
			throw new NodeOperationError(
				this.getNode(),
				`${label} must be a JSON array of component objects`,
				{ itemIndex, description: `Got ${typeof parsed} instead of an array` },
			);
		}

		return parsed as IDataObject[];
	};

	const override = parseJson(options.componentsOverride, 'Raw Components Override');
	const append = parseJson(options.componentsAppend, 'Extra Components');

	if (override) {
		templateObject.components = override;
	} else if (append) {
		templateObject.components = [
			...((templateObject.components as IDataObject[]) ?? []),
			...append,
		];
	}

	// Generate the correlation key when the user has not supplied one. Without
	// it there is no reliable way to join a status webhook back to the send that
	// produced it once a workflow fans out across many recipients.
	const trackingRef = buildTrackingRef(options.bizOpaqueCallbackData as string, {
		executionId: this.getExecutionId(),
		itemIndex,
		templateName: name,
	});

	const sendOptions: TemplateSendOptions = {
		bizOpaqueCallbackData: trackingRef,
		recipientType: options.recipientType as string,
		// Both of these are only meaningful on the Marketing Messages API; sending
		// them to /messages would just be noise Meta ignores or rejects.
		messageActivitySharing:
			endpoint === 'marketing_messages'
				? (options.messageActivitySharing as boolean)
				: undefined,
		messageSendTtlSeconds:
			endpoint === 'marketing_messages'
				? (options.messageSendTtlSeconds as number)
				: undefined,
	};

	const body = buildSendBody(to, templateObject, sendOptions);

	if (options.validateOnly) {
		return {
			validated: true,
			endpoint: `POST /${phoneNumberId}/${endpoint}`,
			category,
			templateStatus: template.status,
			preview: renderPreview(template),
			body,
		};
	}

	return await sendWithRouting.call(this, {
		normalizeOutput: options.normalizeOutput !== false,
		includeRaw: options.includeRaw === true,
		languageCode: language,
		category,
		trackingRef,
		phoneNumberId,
		endpoint,
		body,
		templateObject,
		to,
		sendOptions,
		itemIndex,
		templateName: name,
		fallbackAllowed: options.fallbackToCloudApi !== false,
		maxRetries: (options.maxRetries as number) ?? 2,
		nonDeliveryHandling: (options.nonDeliveryHandling as 'output' | 'error') ?? 'output',
	});
}

interface RoutingArgs {
	phoneNumberId: string;
	endpoint: SendEndpoint;
	body: IDataObject;
	templateObject: IDataObject;
	to: string;
	sendOptions: TemplateSendOptions;
	itemIndex: number;
	templateName: string;
	fallbackAllowed: boolean;
	maxRetries: number;
	nonDeliveryHandling: 'output' | 'error';
	normalizeOutput: boolean;
	includeRaw: boolean;
	languageCode: string;
	category?: string;
	trackingRef?: string;
}

/**
 * One send, with three behaviours layered on top, all keyed off Meta's
 * documented error codes rather than message text:
 *
 *   1. Retry transient server-side failures (downtime, maintenance mode,
 *      throughput) with exponential backoff.
 *   2. Fall back Marketing Messages API → Cloud API when Meta says the template
 *      is still syncing, the WABA is not onboarded, or the endpoint will not
 *      take this message.
 *   3. Fall back Cloud API → Marketing Messages API when the business has
 *      disabled marketing templates on Cloud API (code 131063).
 *
 * Codes in DO_NOT_RETRY_CODES — opt-outs, blocks, policy pauses, per-user
 * limits — never trigger either fallback. Replaying those elsewhere fails
 * identically and, in the opt-out case, Meta explicitly tells you not to.
 */
async function sendWithRouting(
	this: IExecuteFunctions,
	args: RoutingArgs,
): Promise<IDataObject> {
	const { phoneNumberId, body, itemIndex, templateName, maxRetries } = args;

	const attempt = async (endpoint: SendEndpoint, payload: IDataObject) => {
		const response = (await waApiRequest.call(
			this as never,
			'POST',
			sendUrl(phoneNumberId, endpoint),
			payload,
		)) as IDataObject;

		if (!args.normalizeOutput) return response;

		return normalizeSendResponse(response, {
			endpoint: `POST /${phoneNumberId}/${endpoint}`,
			routedVia: endpoint,
			templateName,
			languageCode: args.languageCode,
			category: args.category,
			trackingRef: args.trackingRef,
			includeRaw: args.includeRaw,
		}) as unknown as IDataObject;
	};

	let lastError: unknown;

	for (let tries = 0; tries <= maxRetries; tries++) {
		try {
			return await attempt(args.endpoint, body);
		} catch (error) {
			lastError = error;
			const parsed = parseWaError(error);

			if (isRetryable(parsed) && tries < maxRetries) {
				await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(tries)));
				continue;
			}
			break;
		}
	}

	let parsed = parseWaError(lastError);

	/**
	 * Replay on the other endpoint. If the replay *also* fails, its error
	 * replaces the original and falls through to the classification below rather
	 * than escaping — a fallback that lands on `131049` still deserves the
	 * deferred treatment, not a hard throw.
	 */
	const replay = async (
		endpoint: SendEndpoint,
		payload: IDataObject,
		from: SendEndpoint,
	): Promise<IDataObject | undefined> => {
		try {
			const response = await attempt(endpoint, payload);
			return {
				...response,
				_routedVia: endpoint,
				_fallbackFrom: from,
				_fallbackCode: parsed.code,
				_fallbackReason: parsed.details ?? parsed.message,
			};
		} catch (error) {
			lastError = error;
			parsed = parseWaError(error);
			return undefined;
		}
	};

	// Which endpoint produced the error that is finally reported. It moves when a
	// fallback runs and fails, so the output names the request that actually did.
	let finalEndpoint = args.endpoint;

	if (args.fallbackAllowed && shouldFallbackToCloudApi(parsed, args.endpoint)) {
		// message_activity_sharing and message_send_ttl_seconds are MM-only, so
		// the replayed body must drop them.
		finalEndpoint = 'messages';
		const response = await replay(
			'messages',
			buildSendBody(args.to, args.templateObject, {
				bizOpaqueCallbackData: args.sendOptions.bizOpaqueCallbackData,
				recipientType: args.sendOptions.recipientType,
			}),
			'marketing_messages',
		);
		if (response !== undefined) return response;
	} else if (args.fallbackAllowed && shouldFallbackToMarketingApi(parsed, args.endpoint)) {
		finalEndpoint = 'marketing_messages';
		const response = await replay(
			'marketing_messages',
			buildSendBody(args.to, args.templateObject, args.sendOptions),
			'messages',
		);
		if (response !== undefined) return response;
	}

	// A message Meta declined to deliver *right now* is not the same as one the
	// recipient refused. Throwing on the first kind quietly destroys messages the
	// recipient never opted out of, so both are reported as structured, clearly
	// undelivered output that a Wait or queue node can act on.
	let cls = classifyWaError(parsed);
	if (cls === 'retryable') cls = 'deferred'; // inline retries exhausted

	// A reroute that never happened — fallback switched off, or the replay failed
	// too — leaves a code whose only remedy was the other endpoint. Where Meta
	// documents a wait for it anyway (134101, template still syncing to the ad
	// account), defer rather than throw: the message is deliverable in minutes,
	// and throwing discards it.
	if ((cls === 'mm_fallback' || cls === 'cloud_marketing_disabled') && isDeferred(parsed)) {
		cls = 'deferred';
	}

	const disposition = dispositionOf(cls);

	if (
		args.nonDeliveryHandling === 'output' &&
		(disposition === 'retry_later' || disposition === 'suppress')
	) {
		const waitMs = retryAfterMs(parsed) ?? (disposition === 'retry_later' ? 15 * 60 * 1000 : 0);

		return {
			_delivered: false,
			_disposition: disposition,
			_errorClass: cls,
			_code: parsed.code,
			_reason: parsed.details ?? parsed.message,
			_guidance: explainWaError(parsed),
			_fbtraceId: parsed.fbtraceId,
			_attemptedEndpoint: `POST /${phoneNumberId}/${finalEndpoint}`,
			_templateName: templateName,
			_recipient: args.to,
			_trackingRef: args.trackingRef,
			// retry_later: Meta throttled a message the recipient still wants.
			// suppress: do not send to this recipient again without a data change.
			...(disposition === 'retry_later'
				? {
						_retryAfterMs: waitMs,
						_retryAfter: new Date(Date.now() + waitMs).toISOString(),
					}
				: {}),
		};
	}

	throw toNodeError(this.getNode(), lastError, {
		itemIndex,
		endpoint: `POST /${phoneNumberId}/${finalEndpoint}`,
		templateName,
	});
}
