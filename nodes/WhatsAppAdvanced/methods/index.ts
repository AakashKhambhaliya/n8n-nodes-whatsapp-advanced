import type {
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodePropertyOptions,
	ResourceMapperFields,
} from 'n8n-workflow';

import { buildFieldsFromTemplate } from '../helpers/templateParser';
import { CREDENTIALS_TYPE, fetchPhoneNumbers, fetchTemplate, fetchTemplates } from '../transport';

/**
 * `name|language` matches the value format the official WhatsApp node uses, so
 * an existing workflow can be migrated by copying the string across.
 */
export function splitTemplateValue(value: string): { name: string; language: string } {
	const [name = '', language = ''] = String(value ?? '').split('|');
	return { name: name.trim(), language: language.trim() };
}

const STATUS_ICON: Record<string, string> = {
	APPROVED: '✅',
	PENDING: '🕓',
	REJECTED: '❌',
	PAUSED: '⏸️',
	DISABLED: '🚫',
};

async function wabaId(this: ILoadOptionsFunctions): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIALS_TYPE);
	return credentials.businessAccountId as string;
}

export const listSearch = {
	async searchTemplates(
		this: ILoadOptionsFunctions,
		filter?: string,
	): Promise<INodeListSearchResult> {
		const templates = await fetchTemplates.call(this, await wabaId.call(this));

		// The MM API accepts MARKETING templates only. Filtering here means the
		// user never discovers that restriction from a Meta error code.
		const endpoint = this.getCurrentNodeParameter('messagingEndpoint') as string | undefined;
		const marketingOnly = endpoint === 'marketing_messages';

		const results: INodeListSearchItems[] = templates
			.filter((template) => !marketingOnly || template.category === 'MARKETING')
			.filter((template) => {
				if (!filter) return true;
				const needle = filter.toLowerCase();
				return (
					template.name.toLowerCase().includes(needle) ||
					String(template.language).toLowerCase().includes(needle)
				);
			})
			.map((template) => {
				const icon = STATUS_ICON[String(template.status)] ?? '•';
				const count = buildFieldsFromTemplate(template).length;
				const variables = `${count} variable${count === 1 ? '' : 's'}`;

				return {
					name: `${icon} ${template.name} — ${template.language} · ${template.category} · ${variables}`,
					value: `${template.name}|${template.language}`,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));

		return { results };
	},
};

export const loadOptions = {
	/**
	 * A number can sit in a business account looking perfectly configured and
	 * still reject every send with "(#133010) Account not registered", because it
	 * was never registered against the Cloud API. The WABA-level credential test
	 * passes regardless — it never touches a number. So the registration state
	 * goes in the label, where it is visible before a send rather than after.
	 */
	async getPhoneNumbers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		const numbers = await fetchPhoneNumbers.call(this, await wabaId.call(this));

		return numbers.map((number) => {
			const label = `${number.verified_name ?? 'Unnamed'} ${
				number.display_phone_number ?? ''
			}`.trim();

			const registered =
				number.platform_type === undefined || number.platform_type === 'CLOUD_API';

			const notes: string[] = [];
			if (!registered) {
				notes.push(
					`Not registered on the Cloud API (platform_type: ${number.platform_type}) — sending will fail with (#133010). Run POST /${number.id}/register.`,
				);
			}
			if (number.status && number.status !== 'CONNECTED') notes.push(`Status: ${number.status}`);
			if (number.quality_rating) notes.push(`Quality rating: ${number.quality_rating}`);

			return {
				name: registered ? label : `⚠️ ${label} — not registered`,
				value: number.id,
				description: notes.length > 0 ? notes.join(' · ') : undefined,
			};
		});
	},
};

export const resourceMapping = {
	/**
	 * Called whenever `template.value` or `messagingEndpoint` changes — that
	 * dependency, declared in the property's `loadOptionsDependsOn`, is the
	 * entire mechanism behind "the fields rebuild when you switch template".
	 *
	 * Never throws. A half-configured node is the normal state while the user is
	 * still filling the form, and an exception here renders a red error box
	 * where an empty field list belongs.
	 */
	async getTemplateParameters(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
		try {
			const raw = this.getNodeParameter('template', '', { extractValue: true }) as string;
			const { name, language } = splitTemplateValue(raw);
			if (!name || !language) return { fields: [] };

			const template = await fetchTemplate.call(this, await wabaId.call(this), name, language);
			if (!template) {
				return {
					fields: [],
					emptyFieldsNotice: `No template named “${name}” in “${language}” on this business account`,
				};
			}

			return { fields: buildFieldsFromTemplate(template) };
		} catch (error) {
			// Still no throw — a red box where a field list belongs is worse than an
			// empty one. But an empty list caused by an expired token must not read
			// as "this template takes no variables".
			return {
				fields: [],
				emptyFieldsNotice: `Could not read templates from Meta: ${(error as Error).message}`,
			};
		}
	},
};
