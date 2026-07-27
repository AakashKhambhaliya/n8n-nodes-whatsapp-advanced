import type { INodeProperties } from 'n8n-workflow';

const showForMessage = { resource: ['message'] };
const showForSendTemplate = { resource: ['message'], operation: ['sendTemplate'] };

export const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		default: 'message',
		options: [
			{
				name: 'Delivery Status',
				value: 'status',
				description: 'Turn WhatsApp Trigger output into classified delivery events',
			},
			{ name: 'Message', value: 'message', description: 'Send a message' },
			{ name: 'Template', value: 'template', description: 'Read approved message templates' },
		],
	},

	// -----------------------------------------------------------------------
	// Operations
	// -----------------------------------------------------------------------
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'sendTemplate',
		displayOptions: { show: showForMessage },
		options: [
			{
				name: 'Send Template',
				value: 'sendTemplate',
				description: 'Send an approved template with its variables filled in',
				action: 'Send a template message',
			},
			{
				name: 'Send Text',
				value: 'sendText',
				description:
					'Send free-form text. Only valid inside an open 24-hour customer service window.',
				action: 'Send a text message',
			},
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'list',
		displayOptions: { show: { resource: ['template'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get one template with its parsed variables and a rendered preview',
				action: 'Get a template',
			},
			{
				name: 'List',
				value: 'list',
				description: 'List the templates on this business account',
				action: 'List templates',
			},
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'parseWebhook',
		displayOptions: { show: { resource: ['status'] } },
		options: [
			{
				name: 'Parse Webhook',
				value: 'parseWebhook',
				description: 'Classify the delivery statuses in a WhatsApp Trigger payload',
				action: 'Parse a status webhook',
			},
		],
	},

	// -----------------------------------------------------------------------
	// FEATURE 2 — send endpoint
	// -----------------------------------------------------------------------
	{
		displayName: 'Send Via',
		name: 'messagingEndpoint',
		type: 'options',
		noDataExpression: true,
		default: 'auto',
		displayOptions: { show: showForMessage },
		description:
			'Which of Meta\'s two send endpoints this message goes to. Changing it also changes which templates the picker offers.',
		options: [
			{
				name: 'Auto — Route by Template Category',
				value: 'auto',
				description:
					'MARKETING templates go to the Marketing Messages API, everything else to the Cloud API',
			},
			{
				name: 'Cloud API (/Messages)',
				value: 'messages',
				description:
					'The standard endpoint. Accepts every message type and every template category.',
			},
			{
				name: 'Marketing Messages API (/Marketing Messages)',
				value: 'marketing_messages',
				description:
					'MARKETING templates only. Adds Meta delivery optimisation, send TTL and click webhooks, and needs the Marketing Messages Terms of Service accepted at the business-portfolio level.',
			},
		],
	},

	// -----------------------------------------------------------------------
	// Message fields
	// -----------------------------------------------------------------------
	{
		displayName: 'Sender Phone Number Name or ID',
		name: 'phoneNumberId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getPhoneNumbers' },
		default: '',
		required: true,
		displayOptions: { show: showForMessage },
		description:
			'The number this message is sent from. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Recipient Phone Number',
		name: 'recipientPhoneNumber',
		type: 'string',
		default: '',
		required: true,
		placeholder: '+14155552671',
		displayOptions: { show: showForMessage },
		description:
			'Recipient in international format. Everything that is not a digit is stripped before sending.',
	},
	{
		displayName: 'Text',
		name: 'textBody',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		displayOptions: { show: { resource: ['message'], operation: ['sendText'] } },
		description: 'The message body',
	},

	// -----------------------------------------------------------------------
	// FEATURE 1 — template picker
	// -----------------------------------------------------------------------
	{
		displayName: 'Template',
		name: 'template',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		displayOptions: {
			show: { resource: ['message', 'template'], operation: ['sendTemplate', 'get'] },
		},
		description:
			'The approved template to send. Its variables are read from Meta and become the fields below.',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchTemplates', searchable: true },
			},
			{
				displayName: 'By Name and Language',
				name: 'name',
				type: 'string',
				placeholder: 'order_update|en_US',
				validation: [
					{
						type: 'regex',
						properties: {
							regex: '^[a-z0-9_]+\\|[A-Za-z]{2,3}(_[A-Za-z]{2,4})?$',
							errorMessage: 'Use the format name|language, for example order_update|en_US',
						},
					},
				],
			},
		],
	},

	// -----------------------------------------------------------------------
	// FEATURE 1 — generated variable fields
	// -----------------------------------------------------------------------
	{
		displayName: 'Variables',
		name: 'templateParameters',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		displayOptions: { show: showForSendTemplate },
		description: 'One field per variable in the selected template',
		typeOptions: {
			// This dependency is the whole mechanism behind "the fields rebuild
			// when you switch template". Renaming either parameter breaks it.
			loadOptionsDependsOn: ['template.value', 'messagingEndpoint'],
			resourceMapper: {
				resourceMapperMethod: 'getTemplateParameters',
				mode: 'add',
				valuesLabel: 'Variables to send',
				fieldWords: { singular: 'variable', plural: 'variables' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: true,
				noFieldsError: 'This template takes no variables — nothing to fill in',
				hideNoDataError: true,
			},
		},
	},

	// -----------------------------------------------------------------------
	// The one thing everybody gets wrong about this API
	// -----------------------------------------------------------------------
	{
		displayName:
			'A send returns Meta’s <b>acceptance</b>, not a delivery. The output says <code>status: accepted</code> and <code>delivered: false</code> — that means queued, and Meta offers no endpoint to ask again later. Delivery outcomes and most error codes arrive only on the webhook: add the <b>WhatsApp Trigger</b> and feed it into this node’s <b>Delivery Status → Parse Webhook</b> operation, joining the two halves on <code>trackingRef</code>.',
		name: 'acceptanceNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { resource: ['message'] } },
	},

	// -----------------------------------------------------------------------
	// Delivery status
	// -----------------------------------------------------------------------
	{
		displayName: 'Webhook Payload',
		name: 'webhookPayload',
		type: 'json',
		default: '={{ $json }}',
		required: true,
		displayOptions: { show: { resource: ['status'] } },
		description:
			'The item coming out of the built-in WhatsApp Trigger. The full envelope or a bare change value both work.',
	},
	{
		displayName: 'Options',
		name: 'statusOptions',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { resource: ['status'] } },
		options: [
			{
				displayName: 'Include Raw Status',
				name: 'includeRaw',
				type: 'boolean',
				default: false,
				description: 'Whether to attach Meta’s untouched status object to each event',
			},
			{
				displayName: 'Only Failures',
				name: 'onlyFailures',
				type: 'boolean',
				default: false,
				description: 'Whether to emit only events whose status is failed',
			},
			{
				displayName: 'Suppress Empty Output',
				name: 'suppressEmpty',
				type: 'boolean',
				default: true,
				description:
					'Whether to output nothing when the payload carries no statuses. Inbound-message webhooks arrive on the same field, so this is normal traffic rather than an error.',
			},
		],
	},

	// -----------------------------------------------------------------------
	// Template list filters
	// -----------------------------------------------------------------------
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add filter',
		default: {},
		displayOptions: { show: { resource: ['template'], operation: ['list'] } },
		options: [
			{
				displayName: 'Category',
				name: 'category',
				type: 'options',
				default: 'MARKETING',
				options: [
					{ name: 'Authentication', value: 'AUTHENTICATION' },
					{ name: 'Marketing', value: 'MARKETING' },
					{ name: 'Utility', value: 'UTILITY' },
				],
			},
			{
				displayName: 'Language',
				name: 'language',
				type: 'string',
				default: '',
				placeholder: 'en_US',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'APPROVED',
				options: [
					{ name: 'Approved', value: 'APPROVED' },
					{ name: 'Disabled', value: 'DISABLED' },
					{ name: 'Paused', value: 'PAUSED' },
					{ name: 'Pending', value: 'PENDING' },
					{ name: 'Rejected', value: 'REJECTED' },
				],
			},
		],
	},

	// -----------------------------------------------------------------------
	// Message options
	// -----------------------------------------------------------------------
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: showForMessage },
		options: [
			{
				displayName: 'Extra Components (JSON)',
				name: 'componentsAppend',
				type: 'json',
				default: '',
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'A JSON array of component objects appended to the generated components. Use it for template families the parser does not model.',
			},
			{
				displayName: 'Fall Back to Cloud API',
				name: 'fallbackToCloudApi',
				type: 'boolean',
				default: true,
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'Whether to replay the send on the other endpoint when Meta reports the account or template as ineligible. Opt-outs and blocked recipients are never replayed.',
			},
			{
				displayName: 'Include Raw Response',
				name: 'includeRaw',
				type: 'boolean',
				default: false,
				description: 'Whether to attach Meta’s untouched response alongside the normalised one',
			},
			{
				displayName: 'Max Retries',
				name: 'maxRetries',
				type: 'number',
				default: 2,
				typeOptions: { minValue: 0, maxValue: 5 },
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'How many times to retry transient Meta-side failures, with exponential backoff',
			},
			{
				displayName: 'Message Activity Sharing',
				name: 'messageActivitySharing',
				type: 'boolean',
				default: false,
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'Whether to ask Meta for click and activity webhooks. Marketing Messages API only — it is dropped on the Cloud API.',
			},
			{
				displayName: 'Message Send TTL (Seconds)',
				name: 'messageSendTtlSeconds',
				type: 'number',
				default: 43200,
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'How long Meta may keep trying to deliver. Marketing Messages API only — it is dropped on the Cloud API.',
			},
			{
				displayName: 'Non-Delivery Handling',
				name: 'nonDeliveryHandling',
				type: 'options',
				default: 'output',
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				options: [
					{
						name: 'Error',
						value: 'error',
						description: 'Throw, failing the item',
					},
					{
						name: 'Output a Marked Item',
						value: 'output',
						description:
							'Emit an item with _delivered false and a disposition, so a Wait or queue node can act on it',
					},
				],
				description:
					'What to do when Meta declines to deliver right now — a frequency cap or an opt-out rather than a request error',
			},
			{
				displayName: 'Normalize Output',
				name: 'normalizeOutput',
				type: 'boolean',
				default: true,
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'Whether to return a normalised send result. Turn it off to get Meta’s raw accept payload, as the official node returns.',
			},
			{
				displayName: 'Raw Components Override (JSON)',
				name: 'componentsOverride',
				type: 'json',
				default: '',
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'A JSON array of component objects that replaces the generated components entirely. Needed for payment templates.',
			},
			{
				displayName: 'Recipient Type',
				name: 'recipientType',
				type: 'options',
				default: 'individual',
				options: [{ name: 'Individual', value: 'individual' }],
				description: 'Meta currently accepts individual only',
			},
			{
				displayName: 'Tracking Reference',
				name: 'bizOpaqueCallbackData',
				type: 'string',
				default: '',
				description:
					'Sent as biz_opaque_callback_data and echoed back on the status webhook, joining a send to its outcome. Generated automatically when left blank.',
			},
			{
				displayName: 'Validate Only (Dry Run)',
				name: 'validateOnly',
				type: 'boolean',
				default: false,
				displayOptions: { show: { '/operation': ['sendTemplate'] } },
				description:
					'Whether to assemble and return the payload and a rendered preview without sending anything',
			},
		],
	},
];
