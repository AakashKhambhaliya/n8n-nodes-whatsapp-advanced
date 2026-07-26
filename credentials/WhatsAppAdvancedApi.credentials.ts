import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class WhatsAppAdvancedApi implements ICredentialType {
	name = 'whatsAppAdvancedApi';

	displayName = 'WhatsApp Advanced API';

	documentationUrl = 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started';

	properties: INodeProperties[] = [
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'System user token from your Meta app. It needs both the whatsapp_business_messaging and whatsapp_business_management scopes — reading templates fails without the second one.',
		},
		{
			displayName: 'Business Account ID',
			name: 'businessAccountId',
			type: 'string',
			default: '',
			required: true,
			placeholder: '102290129340398',
			description:
				'WhatsApp Business Account (WABA) ID — <b>not</b> the Phone Number ID. Both are long numbers listed on the same Meta app → WhatsApp → API Setup page, and mixing them up produces “(#133010) Account not registered”. It is also in WhatsApp Manager under account settings.',
		},
		{
			displayName: 'Graph API Version',
			name: 'graphApiVersion',
			type: 'string',
			default: 'v23.0',
			description:
				'Graph API version every request is made against. This is the only place a version is configured.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '=https://graph.facebook.com/{{$credentials.graphApiVersion || "v23.0"}}',
			url: '=/{{$credentials.businessAccountId}}',
			qs: { fields: 'id,name' },
		},
	};
}
