# BUILD-PLAN.md — n8n-nodes-whatsapp-advanced

Single entry point. Everything Claude Code needs to build this project from an empty directory is
in this file plus `CLAUDE.md`. No web research is required — every API fact below has been verified
against Meta's documentation and n8n's source.

---

## 0. How to run this with Claude Code

Put `BUILD-PLAN.md` and `CLAUDE.md` in an empty directory. `CLAUDE.md` is auto-loaded on every
prompt; this file is the thing you point at.

Work one phase at a time. Do **not** ask for the whole build in one prompt — phases 3, 4 and 7 hold
all the subtlety and are far easier to review as isolated diffs than buried in a 2000-line commit.

```bash
claude "Read CLAUDE.md and BUILD-PLAN.md. Implement Phase 0 only. Stop at the Definition of Done and show me the diff."
```

Then for each subsequent phase. The sequence is
**0 → 1 → 2 → 2b → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10**:

```bash
claude "Phase 1. Same rules — implement only that phase, stop at its Definition of Done."
```

After phase 2b:

```bash
claude "Run node test/errors.test.js. Show me every case and confirm the three traps in section 2.5 are handled: 131050 never replays, 100 only falls back from /marketing_messages, 131063 falls back the other direction."
```

After phases 3 and 4:

```bash
claude "Run node test/templates.test.js and show me the generated field IDs and payloads for every fixture. Compare each against the expected payloads in section 7 of BUILD-PLAN.md and tell me about any mismatch."
```

Useful correction prompt if it drifts:

```bash
claude "You changed a locked decision from section 4. Revert that and explain why you thought it needed changing."
```

---

## 1. Project brief

An n8n community node for the WhatsApp Business Platform that beats n8n's built-in
`WhatsApp Business Cloud` node in two specific ways:

1. **Template-aware variable fields.** Picking an approved template generates one labelled input
   per template variable, with the variable name and surrounding message copy in the field heading.
   Changing the template rebuilds the inputs.
2. **Send-endpoint selection.** The user picks Meta's Cloud API `/messages` endpoint, the Marketing
   Messages API `/marketing_messages` endpoint, or lets the node route automatically by template
   category.

Everything else exists to serve those two features.

### Why the official node needs replacing

| Problem in `nodes-base/nodes/WhatsApp` | Effect |
| --- | --- |
| Never reads the template's `components` | Cannot know a template has three variables, so it asks for none and validates nothing |
| Parameters are hand-built `fixedCollection` slots | You count `{{1}}`, `{{2}}`, `{{3}}` against WhatsApp Manager in another tab |
| No awareness of `parameter_format` | Named-parameter templates silently produce invalid payloads — it never emits `parameter_name` |
| Switching template leaves stale components | The old template's parameters get sent to the new template |
| Errors surface only from Meta | `(#132000) Number of parameters does not match`, after the workflow ran |
| `/messages` is hardcoded, Graph `v13.0` is hardcoded | No Marketing Messages API, no version control |

---

## 2. Verified API reference

Do not re-derive any of this. Base URL `https://graph.facebook.com/{version}`, version pinned in
the credential, default `v23.0`.

### 2.1 Endpoints

| Call | Purpose |
| --- | --- |
| `GET /{WABA_ID}/message_templates?fields=…&name=…&limit=200` | templates + variable schema |
| `GET /{WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating` | sender dropdown |
| `GET /{WABA_ID}?fields=id,name` | credential test |
| `POST /{PHONE_NUMBER_ID}/messages` | Cloud API send |
| `POST /{PHONE_NUMBER_ID}/marketing_messages` | Marketing Messages API send |

**Always request `fields=id,name,language,status,category,sub_category,parameter_format,components,message_send_ttl_seconds,quality_score`.**
Meta omits `components` and `parameter_format` from the default projection on some Graph versions,
and without them the entire feature is impossible.

Meta's `name` query filter is a **prefix match** — `order_update` also matches `order_update_v2`.
Always compare exactly on the client as well.

Pagination is cursor-based via `paging.cursors.after`; stop when `paging.next` is absent.

### 2.2 Template read shape

```jsonc
{
  "id": "…", "name": "order_update", "language": "en_US",
  "status": "APPROVED | PENDING | REJECTED | PAUSED | DISABLED",
  "category": "MARKETING | UTILITY | AUTHENTICATION",
  "parameter_format": "POSITIONAL | NAMED",     // absent means POSITIONAL
  "components": [
    { "type": "HEADER", "format": "TEXT|IMAGE|VIDEO|DOCUMENT|LOCATION|PRODUCT", "text": "…",
      "example": { "header_text": ["…"],
                   "header_text_named_params": [{ "param_name": "…", "example": "…" }],
                   "header_handle": ["…"] } },
    { "type": "BODY", "text": "Hi {{1}}…",
      "example": { "body_text": [["…"]],
                   "body_text_named_params": [{ "param_name": "…", "example": "…" }] } },
    { "type": "FOOTER", "text": "…" },
    { "type": "BUTTONS", "buttons": [
        { "type": "URL", "text": "…", "url": "https://x.com/{{1}}", "example": ["…"] },
        { "type": "QUICK_REPLY", "text": "…" },
        { "type": "COPY_CODE", "text": "…" },
        { "type": "FLOW", "text": "…", "flow_id": "…", "flow_name": "…" },
        { "type": "OTP", "otp_type": "COPY_CODE|ONE_TAP|ZERO_TAP", "text": "…" },
        { "type": "CATALOG" }, { "type": "MPM" },
        { "type": "PHONE_NUMBER" }, { "type": "VOICE_CALL" } ] },
    { "type": "CAROUSEL", "cards": [ { "components": [ /* HEADER, BODY, BUTTONS */ ] } ] },
    { "type": "LIMITED_TIME_OFFER", "limited_time_offer": { "has_expiration": true } }
  ]
}
```

Note the **three different example shapes**. Normalise them in one function.

### 2.3 Send payload — verified parameter shapes

```jsonc
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "…", "language": { "code": "en_US" },
    "components": [ /* see below */ ]
  }
}
```

| Situation | Component / parameter |
| --- | --- |
| Body, positional | `{ "type":"body", "parameters":[{ "type":"text", "text":"Ravi" }] }` |
| Body, named | `{ "type":"text", "text":"Priya", "parameter_name":"first_name" }` |
| Media header, URL | `{ "type":"image", "image":{ "link":"https://…" } }` |
| Media header, uploaded asset | `{ "type":"image", "image":{ "id":"1558081531584829" } }` |
| Document filename | `"document": { "id":"…", "filename":"invoice.pdf" }` |
| Location header | `{ "type":"location", "location":{ "latitude","longitude","name","address" } }` |
| Product header | `{ "type":"product", "product":{ "product_retailer_id","catalog_id" } }` |
| URL button | `{ "type":"button", "sub_type":"url", "index":"0", "parameters":[{ "type":"text", "text":"blue-elf" }] }` |
| Quick reply button | `{ "type":"button", "sub_type":"quick_reply", "index":"0", "parameters":[{ "type":"payload", "payload":"more-aloes" }] }` |
| Coupon button | `{ "type":"button", "sub_type":"copy_code", "index":"0", "parameters":[{ "type":"coupon_code", "coupon_code":"SUMMER30" }] }` |
| Flow button | `{ "type":"button", "sub_type":"flow", "index":"0", "parameters":[{ "type":"action", "action":{ "flow_token","flow_action_data" } }] }` |
| Catalog button | `{ "type":"button", "sub_type":"catalog", "index":"0", "parameters":[{ "type":"action", "action":{ "thumbnail_product_retailer_id" } }] }` |
| MPM button | `{ "type":"button", "sub_type":"mpm", "index":"0", "parameters":[{ "type":"action", "action":{ "thumbnail_product_retailer_id", "sections":[{ "title", "product_items":[{ "product_retailer_id" }] }] } }] }` |
| Limited-time offer | `{ "type":"limited_time_offer", "parameters":[{ "type":"limited_time_offer", "limited_time_offer":{ "expiration_time_ms" } }] }` |
| Carousel | `{ "type":"carousel", "cards":[{ "card_index":0, "components":[ … ] }] }` |
| Authentication | body `[{ "type":"text", "text":"482913" }]` **and** `{ "type":"button", "sub_type":"url", "index":"0", "parameters":[{ "type":"text", "text":"482913" }] }` — same code in both, `sub_type` is `url` for copy-code *and* one-tap |

### 2.4 Endpoint differences

| | `/messages` | `/marketing_messages` |
| --- | --- | --- |
| Message types | all | template only |
| Template categories | all | MARKETING only |
| `message_send_ttl_seconds` for marketing templates | not supported | supported |
| `message_activity_sharing: true` (click webhooks) | not supported | supported |
| Prerequisite | none | MM API Terms of Service accepted at business-portfolio level |
| Delivery | standard | Meta optimises recipients and timing |
| Pricing category on the status webhook | `marketing` | `marketing_lite` |

Payloads are otherwise identical. **Webhooks are identical** — the built-in `WhatsApp Trigger` keeps
working, so do not build a trigger node.

Eligibility failures are common in the first ~10 minutes after a marketing template is approved,
while it syncs to the linked ad account.

---

### 2.4b Send responses are acceptances, not deliveries

Both endpoints return the same thing on success:

```json
{ "messaging_product": "whatsapp",
  "contacts": [{ "input": "919824352916", "wa_id": "919824352916" }],
  "messages": [{ "id": "wamid.HBgMOTE5…", "message_status": "accepted" }] }
```

`accepted` means Meta queued it. It is **not** delivery, it does not say which endpoint was used,
and it carries no key for correlating the eventual outcome. The official node returns this verbatim
and stops, which is why a workflow using it cannot tell a delivered message from one that failed
thirty seconds later.

The real outcome arrives on the `messages` webhook as a `statuses` entry:

```jsonc
{ "object": "whatsapp_business_account",
  "entry": [{ "id": "<WABA_ID>", "changes": [{ "field": "messages", "value": {
    "metadata": { "display_phone_number": "…", "phone_number_id": "…" },
    "statuses": [{
      "id": "wamid.…",
      "status": "sent | delivered | read | failed | deleted",
      "timestamp": "1769000200",
      "recipient_id": "919824352916",
      "biz_opaque_callback_data": "<echoed back unchanged>",
      "conversation": { "id": "…", "origin": { "type": "marketing" } },
      "pricing": { "billable": true, "category": "marketing | marketing_lite | utility | authentication" },
      "errors": [{ "code": 131049, "title": "…", "error_data": { "details": "…" }, "href": "…" }]
    }],
    "errors": [ /* account-level, beside statuses */ ]
  } }] }] }
```

Consequences the node must respect:

- **`sent` is not `delivered`.** `sent` means it left Meta. Only `delivered` and `read` mean it
  arrived. Conflating them is what makes delivery dashboards lie.
- **Most error codes are only ever visible here.** `131049`, `131050`, `131026`, `132000` and the
  rest surface in `statuses[].errors[]`, never in the send response. A send node alone cannot
  handle "all error codes" — the webhook half is not optional.
- **Webhook errors are shaped differently** from HTTP errors: flat, with `title` and `href` instead
  of `type` and `fbtrace_id`. `parseWaError` must accept both and normalise to one `WaError`.
- **`biz_opaque_callback_data` is the only reliable join key** between a send and its outcome once
  a workflow fans out across recipients. Generate one when the user does not supply it.

### 2.5 Error codes — see ERRORS.md for the full mapping

Meta's guidance: build error handling around `code` and `error_data.details`. `error_subcode` is
deprecated and absent from v16.0+ responses; titles inside `message` are also being deprecated.

| Class | Codes | Disposition |
| --- | --- | --- |
| `retryable` | 1, 2, 130429, 131000, 131016, 131057, 133004, 2494100 | `retry_now` |
| `deferred` | 131049, 131056, 131048, 131064, 4, 80007, 133016, 134101 | `retry_later` |
| `mm_fallback` | 100, 131009, 131055, 134100, 134101, 134102 | `reroute` → `/messages` |
| `cloud_marketing_disabled` | 131063 | `reroute` → `/marketing_messages` |
| `opt_out` | 131050 | `suppress` |
| `undeliverable` | 130403, 131021, 131026 | `suppress` |
| `template_mismatch` | 132000, 132001, 132012 | `fix` |
| `fix_required` | 131042, 131045, 131047, 132007, 132015, 132016, 132018, 133010, 134011 | `fix` |
| `auth` | 0, 3, 10, 190, 200, 200–299, 131005 | `fix` |
| `integrity` | 368, 130497, 131031 | `fix` |

Suggested waits for `deferred`: `131049` 24 h and `134101` 10 min are stated by Meta; `131056`,
`4`, `80007` default to 15 min and `131048`, `131064`, `133016` to 24 h as **node defaults**,
because Meta documents the restriction without a duration. Label them as such in the code.

Four traps:

- **Never conflate "the recipient refused" with "Meta said not right now".** `131050` is an opt-out:
  suppress permanently, never carry a retry hint. `131049` is Meta's per-user marketing frequency
  cap and Meta's own text says *"wait at least 24 hours before resending"* — the recipient never
  refused anything. An earlier draft put both in one `do_not_retry` bucket, which silently discards
  paid-for messages. The same applies to `131056`, `131048`, `131064`, `4` and `80007`.
- **`131050` must never be retried or replayed** — Meta says do not retry. An earlier draft treated
  this as an *eligibility* failure and replayed it on Cloud API, which burns quota and delivers
  nothing.
- **`100` is context-dependent** — "unsupported parameter" on Cloud API, "Message must be a
  template message" on the MM API. Only a fallback signal when the request went to
  `/marketing_messages`.
- **Fallback runs both directions** — `131063` means marketing templates are disabled on Cloud API
  via `disable_marketing_messages_on_cloud_api`, and Meta's stated fix is the MM API.

`134101` (template still syncing, up to 10 minutes after approval) is the most common fallback in
practice. Without it, the first ten minutes of a campaign silently drop.

## 3. Architecture

```
n8n-nodes-whatsapp-advanced/
├── CLAUDE.md                                auto-loaded context
├── BUILD-PLAN.md                             this file
├── COVERAGE.md                              template-type coverage matrix (Phase 9)
├── ERRORS.md                                error code mapping and fallback behaviour
├── README.md  DESIGN.md
├── package.json  tsconfig.json  gulpfile.js  .eslintrc.js
├── credentials/
│   └── WhatsAppAdvancedApi.credentials.ts
├── nodes/WhatsAppAdvanced/
│   ├── WhatsAppAdvanced.node.ts             execute(), endpoint routing, fallback
│   ├── whatsapp.svg
│   ├── descriptions/index.ts                all INodeProperties
│   ├── transport/index.ts                   Graph requests, cache, error classifier
│   ├── methods/index.ts                     listSearch · loadOptions · resourceMapping
│   └── helpers/
│       ├── interfaces.ts
│       ├── errors.ts                        Meta error code → class → disposition
│       ├── response.ts                      accept payload → normalised send result
│       ├── webhook.ts                       status webhook → classified delivery events
│       ├── templateParser.ts                template → ResourceMapperField[]   ← FEATURE 1
│       └── payloadBuilder.ts                values   → template.components
└── test/
    ├── templates.test.js
    ├── errors.test.js
    └── webhook.test.js
```

`helpers/templateParser.ts`, `helpers/payloadBuilder.ts`, `helpers/errors.ts`, `helpers/response.ts`
and `helpers/webhook.ts` are **pure** — no `this`, no network, no
n8n context. That is what makes them testable with plain `node` and no n8n running.

Use the **programmatic** node style (`async execute()`), not declarative `routing`. Declarative
cannot express "call a method to decide the form's shape" or "retry a different endpoint on a
specific error code", both of which are required.

---

## 4. Locked design decisions

Do not change these without asking. They were settled during design and each one is load-bearing.

### 4.1 Field IDs encode everything

At execution time n8n hands the node the resource mapper's stored `schema` plus the user's `value`
object and **nothing else**. So component, sub-type and position must live inside the field ID:

```
h::text::<key>                            header text variable
h::media::<image|video|document>          header media (URL or media ID)
h::media_filename                         document filename (optional)
h::loc::<latitude|longitude|name|address>
h::product::<product_retailer_id|catalog_id>
b::text::<key>                            body text variable
btn::<i>::url::<key>                      dynamic URL suffix
btn::<i>::quick_reply_payload             quick reply postback payload (optional)
btn::<i>::copy_code                       coupon code
btn::<i>::flow_token                      Flow token (optional)
btn::<i>::flow_action_data                Flow action payload, JSON (optional)
btn::<i>::catalog_thumbnail               catalog thumbnail retailer ID (optional)
btn::<i>::mpm_thumbnail                   MPM thumbnail retailer ID (optional)
btn::<i>::mpm_sections                    MPM sections, JSON array
lto::expiration_time_ms                   limited-time-offer expiry
auth::otp[::<otpButtonIndex>]             authentication one-time code
card::<c>::<any of the above>             scoped to carousel card c
```

Separator `::`. Consequence: **the payload builder makes zero network calls.** A campaign sending
50 000 messages does one cached template lookup, not 50 000.

### 4.2 Digit-only key means positional

Meta requires named parameters to be lowercase letters and underscores. So `b::text::1` is
positional and `b::text::customer_name` is named. That single test decides whether the emitted
parameter carries `parameter_name`. Positional parameters must be sorted **numerically** before
serialisation, so a user filling `{{3}}` before `{{1}}` still gets a correct array.

### 4.3 The resource mapper dependency list

```ts
typeOptions: {
  loadOptionsDependsOn: ['template.value', 'messagingEndpoint'],
  resourceMapper: { resourceMapperMethod: 'getTemplateParameters', mode: 'add', … },
}
```

`loadOptionsDependsOn` is the entire mechanism for "fields change when template changes". Do not
remove it or rename `template` / `messagingEndpoint` without updating it.

### 4.4 The four audit fixes

An earlier draft shipped four bugs. Build them correctly the first time:

1. **Quick reply buttons must generate a field.** They take an optional postback `payload`, and
   Meta's carousel documentation includes one on every card. Inside a carousel card show it up
   front (`removed: false`); on a standalone template hide it behind *Add variable*
   (`removed: true`).
2. **MPM needs `sections`, not just a thumbnail.** `sections` with `product_items` is the actual
   content of a multi-product message. Both merge into one `action` object.
3. **`PRODUCT` headers must be handled** or single-product and product-carousel templates generate
   no header field.
4. **Zero-tap authentication must not get a button.** Encode the OTP button index in the field ID
   (`auth::otp::0`); if the template declares no OTP button the ID is plain `auth::otp` and no
   button component is emitted.

---

### 4.5 Errors are classified by code, never by message text

An earlier draft matched substrings like `not onboarded` and `not eligible`. That breaks the moment
Meta rewords a string or the account is on a non-English locale. Every decision keys off the
numeric `code`, with `error_data.details` used only to disambiguate codes Meta reuses. See section
2.5 and `ERRORS.md`.

`transport/index.ts` must **rethrow Meta's original error**, not wrap it in `NodeApiError` —
classification needs the untouched envelope. Wrapping happens at the call site via `toNodeError`.

## 5. Phases

Each phase ends with a **Definition of done** that is a command or an observable behaviour.

### Phase 0 — Scaffold

- [ ] `package.json` named `n8n-nodes-whatsapp-advanced`, MIT, keyword `n8n-community-node-package`
- [ ] `n8n` block:
      ```json
      "n8n": {
        "n8nNodesApiVersion": 1,
        "credentials": ["dist/credentials/WhatsAppAdvancedApi.credentials.js"],
        "nodes": ["dist/nodes/WhatsAppAdvanced/WhatsAppAdvanced.node.js"]
      }
      ```
- [ ] devDeps: `typescript@^5.5`, `gulp@^4`, `eslint@^8`, `eslint-plugin-n8n-nodes-base`,
      `prettier`, `n8n-workflow`. `n8n-workflow` is also a **peerDependency**
- [ ] `tsconfig.json`: `strict`, `commonjs`, `es2019`, `outDir: ./dist`, `declaration`,
      `noUnusedLocals`, include `credentials/**/*` and `nodes/**/*`
- [ ] `gulpfile.js` with `build:icons` copying `nodes/**/*.{png,svg}` → `dist/nodes`
- [ ] `nodes/WhatsAppAdvanced/whatsapp.svg`, 32×32, `#25D366`
- [ ] Scripts: `build` = `tsc && gulp build:icons`, `dev`, `lint`, `format`,
      `test` = `npm run build && node test/templates.test.js`

**Done when:** `npm run build` succeeds.

---

### Phase 1 — Credential

`credentials/WhatsAppAdvancedApi.credentials.ts`

- [ ] `name = 'whatsAppAdvancedApi'`, displayName `WhatsApp Advanced API`
- [ ] `accessToken` — string, `password: true`, required. Mention the scopes:
      `whatsapp_business_messaging`, `whatsapp_business_management`
- [ ] `businessAccountId` — string, required
- [ ] `graphApiVersion` — string, default `'v23.0'`. **The only place a version may appear**
- [ ] `authenticate: IAuthenticateGeneric` injecting `Authorization: =Bearer {{$credentials.accessToken}}`
- [ ] `test: ICredentialTestRequest` → `=https://graph.facebook.com/{{$credentials.graphApiVersion || "v23.0"}}`,
      url `=/{{$credentials.businessAccountId}}`, `qs: { fields: 'id,name' }`

**Done when:** the credential's **Test** button returns the account name against a real WABA.

---

### Phase 2 — Types and transport

`helpers/interfaces.ts`

- [ ] Model section 2.2 exactly: `WaTemplate`, `WaTemplateComponent`, `WaTemplateButton`,
      `WaTemplateCard`, `WaComponentExample` (all three example shapes), `WaTemplateListResponse`
- [ ] `HeaderFormat` must include `'PRODUCT'`
- [ ] `SendEndpoint = 'messages' | 'marketing_messages'`, `EndpointChoice = SendEndpoint | 'auto'`,
      `ParsedPlaceholder`, `TemplateSendOptions`
- [ ] Widen `ButtonType` and component `type` with `| string` so an unknown future Meta type
      degrades to "no fields" rather than a type error

`transport/index.ts`

- [ ] `CREDENTIALS_TYPE`, `DEFAULT_GRAPH_VERSION = 'v23.0'`, `TEMPLATE_FIELDS` (section 2.1)
- [ ] `waApiRequest(method, resource, body?, qs?)` via `this.helpers.httpRequestWithAuthentication`,
      failures wrapped in `NodeApiError`
- [ ] `fetchTemplates(wabaId, nameFilter?)` — cursor pagination, capped at 10 pages
- [ ] `fetchTemplate(wabaId, name, language)` — exact match on both
- [ ] Module-level `Map` cache, key `${wabaId}:${nameFilter ?? '*'}`, TTL 60 s, plus
      `invalidateTemplateCache(wabaId?)`. Without this the resource mapper makes one Graph call per
      dropdown keystroke
- [ ] `sendUrl(phoneNumberId, endpoint)`
- [ ] On failure, attach `parseWaError(error)` to the error and **rethrow the original**. Do not
      wrap in `NodeApiError` here — classification needs Meta's untouched envelope

**Done when:** `npm run build` passes with `noUnusedLocals`, and no `fetch` or version string exists
outside these two files.

---

### Phase 2b — Error classification

`helpers/errors.ts`. **Pure module.** Full detail in `ERRORS.md`; the tables there are normative.

- [ ] `parseWaError(error)` → `{ code, details, message, type, fbtraceId, httpStatus }`. Meta's
      envelope sits at different depths depending on whether n8n's HTTP helper, `NodeApiError` or a
      raw axios failure is in play — dig through `cause.error`, `error.error`,
      `response.body.error`, `response.data.error`
- [ ] Code sets exactly as in section 2.5 below
- [ ] `classifyWaError`, `dispositionOf(class)`, `retryAfterMs(error)`,
      `shouldFallbackToCloudApi(error, sentTo)`, `shouldFallbackToMarketingApi(error, sentTo)`,
      `isRetryable`, `isDeferred`
- [ ] `DEFERRED_CODES` as a `Map<number, { waitMs, metaStated }>` so the plan's distinction between
      Meta-stated and node-default waits survives into the code
- [ ] `explainWaError(error)` — a plain-English next step per documented code
- [ ] `toNodeError(node, error, ctx)` — surfaces Meta's `details`, the guidance, the endpoint, the
      template name and the `fbtrace_id`
- [ ] `backoffDelayMs(attempt)` — exponential with jitter, capped at 8 s

**Done when:** `node test/errors.test.js` passes every classification and disposition case, including
the assertion that `131050` never returns a retry hint.

---

### Phase 3 — FEATURE 1a: parse templates into fields

`helpers/templateParser.ts`. **Pure module.**

- [ ] `SEP = '::'`, `isPositionalKey(key)` = `/^\d+$/`
- [ ] `extractPlaceholders(text)` — regex `/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g`, returns
      `{ key, start, end }[]`. **De-duplicate** — a template may repeat `{{1}}` but Meta expects one
      value, so only the first occurrence becomes a field
- [ ] `contextSnippet(text, placeholder, radius = 24)` — ±24 chars of the approved copy, target
      rendered as `⟨key⟩` so it is visually distinct from neighbours still shown as `{{…}}`,
      whitespace flattened, ellipsis at either end when truncated
- [ ] `exampleFor(component, placeholder, slot, ordinal)` — normalises all three example shapes
- [ ] Label composer producing exactly
      `{Component} · {variable}  ·  {snippet}  (e.g. {example})`,
      where variable is `{{1}}` for positional and `customer_name` for named
- [ ] `buildFieldsFromTemplate(template): ResourceMapperField[]`:

| Component | Fields |
| --- | --- |
| `HEADER` `TEXT` | one per placeholder |
| `HEADER` `IMAGE`/`VIDEO`/`DOCUMENT` | one media field; DOCUMENT also an optional filename (`removed: true`) |
| `HEADER` `LOCATION` | latitude + longitude required, name + address optional |
| `HEADER` `PRODUCT` | product retailer ID required, catalog ID optional |
| `BODY` | one per placeholder |
| `FOOTER` | none |
| `BUTTONS` → `URL` | **only if the URL contains a placeholder** |
| `BUTTONS` → `QUICK_REPLY` | optional payload; `removed: false` inside a card, `removed: true` otherwise |
| `BUTTONS` → `COPY_CODE` | coupon code |
| `BUTTONS` → `FLOW` | flow token + flow action data (`type: 'object'`), both optional |
| `BUTTONS` → `CATALOG` | thumbnail retailer ID, optional |
| `BUTTONS` → `MPM` | `sections` (`type: 'array'`, required) + optional thumbnail |
| `BUTTONS` → `PHONE_NUMBER` / `VOICE_CALL` / `OTP` | none |
| `CAROUSEL` | recurse per card, prefix `card::<i>::`, label `Card N` |
| `LIMITED_TIME_OFFER` | expiry (`type: 'number'`) only when `has_expiration` |
| category `AUTHENTICATION` | **short-circuit: exactly one field.** ID is `auth::otp::<otpButtonIndex>` when the template declares an OTP button, plain `auth::otp` when it does not |

- [ ] `renderPreview(template)` — substitute example values, media headers as `[IMAGE]`, buttons as
      `[ Label ]`, joined with newlines

**Done when:** all ten fixtures in section 7 produce the listed field IDs.

---

### Phase 4 — FEATURE 1b: rebuild the payload

`helpers/payloadBuilder.ts`. **Pure module, zero network calls.**

- [ ] `parseId(id)` — split on `::`, peel an optional leading `card::<n>::`
- [ ] `shortLabel(id)` — compact name (`body {{2}}`, `card 1 header image`) for error messages. Do
      **not** use full field labels in errors; they are far too long
- [ ] `mediaObject(value, filename?)` — `{ link }` when `^https?://`, else `{ id }`. This is what
      lets one field accept both a public URL and an uploaded media ID
- [ ] `textParameter(key, value)` — adds `parameter_name` only when `!isPositionalKey(key)`
- [ ] `sortPositional(entries)` — numeric sort for digit keys, stable for named
- [ ] Bucket accumulator: header text / header media / header location / header product / body text
      / buttons. One bucket for the root, one per carousel card
- [ ] `bucketToComponents(bucket)` emitting header (media → location → product → sorted text), body,
      then buttons sorted by index, using the exact shapes in section 2.3. Fold `flow` and
      `action` sub-objects into `parameters` at the end
- [ ] `buildTemplateObject(args)`:
  - **Validation first.** Fields that are `required && display && !removed` with an empty value →
    `NodeOperationError`, message `Template "<name>" is missing N required variables`,
    description `Fill in: <shortLabel> · <shortLabel> · …`
  - `AUTHENTICATION` short-circuit — find the value whose key starts with `auth::otp`, emit the body
    parameter always, and the `sub_type: 'url'` button **only if** the key carries an index
  - skip `*::media_filename` in the main loop; it is consumed with its media field
  - append `limited_time_offer` after the root components
  - append `{ type: 'carousel', cards: [{ card_index, components }] }` sorted by card index
- [ ] `buildSendBody(to, template, options)` — `messaging_product`, `recipient_type`, `to`,
      `type: 'template'`, `template`, plus `biz_opaque_callback_data`, `message_activity_sharing`,
      `message_send_ttl_seconds` **only when defined**
- [ ] `sanitizePhoneNumber(phone)` — strip all non-digits

**Done when:** every fixture round-trips to the expected payload in section 7.

---

### Phase 5 — Node methods

`methods/index.ts`

- [ ] `splitTemplateValue(value)` — `"name|language"` → `{ name, language }`. Keep this format; it
      matches the official node so workflows can be migrated by hand
- [ ] `listSearch.searchTemplates(filter?)`:
  - label `{icon} {name} — {language} · {category} · {n} variables`, count from
    `buildFieldsFromTemplate`
  - icons: APPROVED ✅, PENDING 🕓, REJECTED ❌, PAUSED ⏸️, DISABLED 🚫
  - **when `messagingEndpoint === 'marketing_messages'`, filter out non-MARKETING templates** — the
    user should never discover that restriction from a Meta error code
- [ ] `loadOptions.getPhoneNumbers()` — label `{verified_name} {display_phone_number}`, description
      shows quality rating
- [ ] `resourceMapping.getTemplateParameters()` — read `template` with `{ extractValue: true }`,
      split, return `{ fields: [] }` if incomplete, else `fetchTemplate` → `buildFieldsFromTemplate`.
      **Never throw here**; an empty schema renders a clean empty state

**Done when:** in a running n8n the dropdown is searchable and shows counts, and switching **Send
Via** to the MM API removes non-marketing templates from the list.

---

### Phase 6 — Node properties

`descriptions/index.ts`

- [ ] `resource`: `message` | `template`
- [ ] `operation` for `message`: `sendTemplate` (default), `sendText`
- [ ] `operation` for `template`: `list`, `get`
- [ ] **FEATURE 2** — `messagingEndpoint`, `type: 'options'`, `noDataExpression: true`, default
      `'auto'`, shown for `resource: ['message']`:
      | value | label |
      | --- | --- |
      | `auto` | Auto — Route by Template Category |
      | `messages` | Cloud API — /messages |
      | `marketing_messages` | Marketing Messages API — /marketing_messages |
      Each needs a `description` explaining the tradeoff.
- [ ] `phoneNumberId` — options, `loadOptionsMethod: 'getPhoneNumbers'`
- [ ] `recipientPhoneNumber` — string, placeholder `+14155552671`
- [ ] `textBody` — only for `sendText`
- [ ] **FEATURE 1 picker** — `template`, `resourceLocator`, modes `list`
      (`searchListMethod: 'searchTemplates'`, `searchable: true`) and `name` (string, placeholder
      `order_update|en_US`, regex `^[a-z0-9_]+\|[A-Za-z]{2,3}(_[A-Za-z]{2,4})?$`)
- [ ] **FEATURE 1 mapper** — `templateParameters`, `type: 'resourceMapper'`, exactly:
      ```ts
      default: { mappingMode: 'defineBelow', value: null },
      typeOptions: {
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
          refreshStaleSchemaOnOpen: true,
          refreshIncompleteSchemaOnOpen: true,
        },
      }
      ```
      `supportAutoMap` matters — an incoming item with a `customer_name` property should fill the
      `{{customer_name}}` slot with no wiring.
- [ ] `options` collection: `bizOpaqueCallbackData`, `messageActivitySharing`,
      `messageSendTtlSeconds`, `fallbackToCloudApi` (default `true`), `maxRetries` (default `2`),
      `nonDeliveryHandling` (default `output`),
      `componentsOverride` (json), `componentsAppend` (json), `validateOnly`, `recipientType`
- [ ] `filters` collection for `template: list`: category, status, language

**Done when:** in n8n, picking a template renders its variables; picking a different one replaces
them; picking the first back restores it.

---

### Phase 7 — FEATURE 2: execute and routing

`WhatsAppAdvanced.node.ts`

- [ ] Class shell: `usableAsTool: true`, one main input/output, subtitle showing the selected
      template for `sendTemplate` and `resource: operation` otherwise
- [ ] `methods = { listSearch, loadOptions, resourceMapping }`
- [ ] `execute()` loops items, honours `continueOnFail()`, sets `pairedItem` on every output
- [ ] `handleTemplateResource`:
  - `get` → template + `renderedPreview` + `variables[]` of `{ id, label, required }`
  - `list` → filtered templates, each with `variableCount`
- [ ] `sendText` → always `/messages`; free-form text is never valid on the MM API
- [ ] **`resolveEndpoint(choice, category, node, itemIndex)`**:
      | choice | category | result |
      | --- | --- | --- |
      | `auto` | MARKETING | `marketing_messages` |
      | `auto` | anything else | `messages` |
      | `messages` | any | `messages` |
      | `marketing_messages` | MARKETING | `marketing_messages` |
      | `marketing_messages` | anything else | **throw**, naming the actual category and telling the user to switch to Cloud API or Auto |
- [ ] `sendTemplate`:
  1. read phone number, recipient, endpoint choice, options, template locator
  2. read `templateParameters` as `ResourceMapperValue`; take `.schema` and `.value`
  3. `fetchTemplate` for the category — the **one** allowed runtime Graph call, and it is cached
  4. throw if `status !== 'APPROVED'`
  5. `resolveEndpoint`
  6. `buildTemplateObject` (validates)
  7. apply `componentsOverride` (replace) or `componentsAppend` (append); both must parse to a JSON
     array or throw a clear error
  8. attach `messageActivitySharing` / `messageSendTtlSeconds` **only** when the resolved endpoint
     is `marketing_messages`
  9. `validateOnly` → return `{ validated, endpoint, category, templateStatus, preview, body }`
     without sending
  10. POST to the resolved endpoint
- [ ] **`sendWithRouting`** wraps the POST with three layers, all keyed off documented codes:
      1. retry `retryable` codes with exponential backoff, `maxRetries` default 2
      2. `mm_fallback` → replay on `/messages`, **dropping** `message_activity_sharing` and
         `message_send_ttl_seconds` since they are MM-only
      3. `cloud_marketing_disabled` → replay on `/marketing_messages`
      Annotate every fallback with `_routedVia`, `_fallbackFrom`, `_fallbackCode`,
      `_fallbackReason`. Never fall back on `opt_out`, `undeliverable` or `fix_required`
- [ ] After inline retries are exhausted, downgrade `retryable` to `deferred` rather than failing
- [ ] **Non-Delivery Handling** option, default `output`: for `retry_later` and `suppress`
      dispositions emit a marked item instead of throwing —
      `{ _delivered: false, _disposition, _errorClass, _code, _reason, _guidance, _retryAfterMs,
      _retryAfter, _recipient, _templateName, _fbtraceId }`. `_retryAfter` must be absent for
      `suppress`, so a retry loop cannot pick up an opt-out
- [ ] `execute()`'s catch wraps with `toNodeError`; under `continueOnFail()` output
      `{ error, code, details, guidance, fbtraceId }` rather than a bare message

**Done when:** a marketing template auto-routes to `/marketing_messages`, a utility template
auto-routes to `/messages`, and forcing a utility template onto the MM API fails inside n8n.

---

### Phase 7b — Delivery status resource

The send path only ever sees acceptances. This phase adds the half that sees outcomes.

`helpers/response.ts`

- [ ] `buildTrackingRef(userValue, { executionId, itemIndex, templateName })` — respect a
      user-supplied value untouched, otherwise generate `n8n:{executionId}:{itemIndex}:{template}`,
      capped at 512 chars
- [ ] `normalizeSendResponse(response, ctx)` → `{ delivered: false, status, messageId, recipient:
      { input, waId }, endpoint, routedVia, template: { name, language, category }, trackingRef,
      sentAt, raw? }`. `delivered` is **always false** on a send — only a webhook can set it true.
      Keep Meta's `message_status` verbatim rather than inferring one

`helpers/webhook.ts`

- [ ] `parseStatusWebhook(payload, includeRaw)` → one `DeliveryEvent` per status. Accept the full
      envelope **or** a bare `entry.changes[].value` object, since trigger configurations differ
- [ ] `delivered` is true for `delivered` and `read` only — never for `sent`
- [ ] Surface `conversationId`, `conversationOrigin`, `pricingCategory`, `billable`,
      `trackingRef`, and an ISO `timestamp` converted from Meta's Unix seconds
- [ ] Run `statuses[].errors[]` through the **same** `classifyWaError` / `dispositionOf` /
      `retryAfterMs` used by the send path, so a `131049` looks identical whichever half surfaced it
- [ ] Handle account-level `value.errors[]` sitting beside `statuses`
- [ ] `isStatusWebhook(payload)` — inbound-message webhooks use the same `messages` field, so they
      must not be mistaken for statuses

Node wiring

- [ ] `Delivery Status` resource with a `Parse Webhook` operation, `webhookPayload` defaulting to
      `={{ $json }}`, and options `onlyFailures`, `includeRaw`, `suppressEmpty`
- [ ] Message options gain `normalizeOutput` (default `true`, off for drop-in compatibility with
      the official node) and `includeRaw`
- [ ] `sendTemplate` generates the tracking ref and passes it as `biz_opaque_callback_data`

**Done when:** `node test/webhook.test.js` passes, and a real failed send produces a webhook event
whose `code`, `disposition` and `retryAfter` match what the send path would have produced.

---

### Phase 8 — Tests

Both suites are plain Node and require from `dist/`. No n8n instance, no network.

- [ ] `test/templates.test.js` — the ten template fixtures in section 7
- [ ] `test/errors.test.js` — the classification and disposition cases in section 7.2
- [ ] `test/webhook.test.js` — the normalisation and webhook cases in section 7.3
- [ ] `package.json`: `"test": "npm run build && node test/templates.test.js && node test/errors.test.js && node test/webhook.test.js"`

**Done when:** `npm test` passes from a clean checkout.

---

### Phase 9 — Docs and lint

- [ ] `README.md` — the two features, an ASCII sketch of the generated form, credential setup table,
      install commands, note that the built-in **WhatsApp Trigger** still handles inbound
- [ ] `DESIGN.md` — gap analysis, the resource-mapper mechanism, the field-ID grammar and why it
      exists, endpoint comparison, architecture, limitations
- [ ] `COVERAGE.md` — the matrix in section 8 of this file
- [ ] `ERRORS.md` — the error class table, the two fallback directions, and the codes the node
      prevents rather than handles
- [ ] `.eslintrc.js` extending `plugin:n8n-nodes-base/community`, `.gitignore`, `.npmignore`
      (ship `dist/` only)

**Done when:** `npm run lint` passes with no `n8n-nodes-base` violations.

---

### Phase 10 — Manual verification against a real WABA

Cannot be automated. Work through before publishing.

- [ ] Credential **Test** returns the business account name
- [ ] Template dropdown shows correct status icons and variable counts
- [ ] Selecting a template renders one input per variable with the variable name in the heading
- [ ] Switching template replaces the inputs; switching back restores them
- [ ] Auto-map fills `{{customer_name}}` from an input item field of the same name
- [ ] Leaving a variable empty fails in n8n naming the variable, not with Meta's `#132000`
- [ ] `Validate Only` returns payload and preview with no message arriving
- [ ] Marketing template auto-routes to `/marketing_messages`
- [ ] Utility template auto-routes to `/messages`
- [ ] Forcing a utility template onto the MM API is rejected inside n8n
- [ ] With MM API not onboarded, the fallback delivers via `/messages` and sets `_routedVia`
- [ ] **A named-parameter template delivers** — the case the official node cannot do
- [ ] A carousel template delivers with all cards populated and quick-reply payloads returned
- [ ] A copy-code authentication template delivers with the code in body and button
- [ ] A zero-tap authentication template delivers with no button component
- [ ] An MPM template delivers with a populated product list
- [ ] `WhatsApp Trigger` receives status webhooks for messages sent via both endpoints
- [ ] A send returns `delivered: false`, `status: 'accepted'`, a `messageId` and a `trackingRef`
- [ ] The status webhook for that same message echoes the identical `trackingRef`, so send and
      outcome can be joined
- [ ] `Delivery Status → Parse Webhook` on a failed send emits the error code, class, disposition
      and — where applicable — `retryAfter`
- [ ] A `sent` status reports `delivered: false`; a `delivered` status reports `delivered: true`
- [ ] Sending a marketing template within 10 minutes of approval falls back to `/messages` and sets
      `_fallbackCode: 134101`
- [ ] Sending to a recipient who has opted out (`131050`) is **not** replayed on the other endpoint,
      and its output carries `_disposition: 'suppress'` with **no** `_retryAfter`
- [ ] A send hitting the per-user marketing cap (`131049`) is **not** treated as a refusal — output
      carries `_disposition: 'retry_later'` and `_retryAfter` roughly 24 hours out, and resending
      after that window succeeds

---

## 6. Function contracts

```ts
// helpers/templateParser.ts
export const SEP = '::';
export function isPositionalKey(key: string): boolean;
export function extractPlaceholders(text?: string): ParsedPlaceholder[];
export function contextSnippet(text: string, p: ParsedPlaceholder, radius?: number): string;
export function buildFieldsFromTemplate(template: WaTemplate): ResourceMapperField[];
export function renderPreview(template: WaTemplate): string;

// helpers/payloadBuilder.ts
export function shortLabel(id: string): string;
export function buildTemplateObject(args: {
  node: INode; itemIndex: number;
  templateName: string; languageCode: string;
  schema: ResourceMapperField[];
  values: Record<string, string | number | boolean | null | undefined>;
  category?: string;
}): IDataObject;
export function buildSendBody(to: string, template: IDataObject, options?: TemplateSendOptions): IDataObject;
export function sanitizePhoneNumber(phone: string): string;

// helpers/errors.ts
export interface WaError { code?: number; details?: string; message: string; type?: string; fbtraceId?: string; httpStatus?: number }
export type WaErrorClass = 'auth' | 'integrity' | 'mm_fallback' | 'cloud_marketing_disabled'
  | 'retryable' | 'deferred' | 'opt_out' | 'undeliverable' | 'template_mismatch'
  | 'fix_required' | 'unknown';
export type WaDisposition = 'retry_now' | 'retry_later' | 'reroute' | 'suppress' | 'fix' | 'unknown';
export function parseWaError(error: unknown): WaError;
export function classifyWaError(error: WaError): WaErrorClass;
export function shouldFallbackToCloudApi(error: WaError, sentTo: string): boolean;
export function shouldFallbackToMarketingApi(error: WaError, sentTo: string): boolean;
export function isRetryable(error: WaError): boolean;
export function isDeferred(error: WaError): boolean;
export function dispositionOf(cls: WaErrorClass): WaDisposition;
export function retryAfterMs(error: WaError): number | undefined;
export function explainWaError(error: WaError): string | undefined;
export function toNodeError(node: INode, error: unknown,
  ctx: { itemIndex?: number; endpoint?: string; templateName?: string }): Error;
export function backoffDelayMs(attempt: number): number;

// helpers/response.ts
export function buildTrackingRef(userValue: string | undefined,
  ctx: { executionId?: string; itemIndex: number; templateName?: string }): string | undefined;
export function normalizeSendResponse(response: IDataObject, ctx: {
  endpoint: string; routedVia: string; templateName?: string; languageCode?: string;
  category?: string; trackingRef?: string; includeRaw?: boolean }): NormalizedSend;

// helpers/webhook.ts
export type DeliveryStatus = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
export function parseStatusWebhook(payload: IDataObject, includeRaw?: boolean): DeliveryEvent[];
export function isStatusWebhook(payload: IDataObject): boolean;

// transport/index.ts
export async function waApiRequest(method, resource, body?, qs?): Promise<any>;
export async function fetchTemplates(wabaId: string, nameFilter?: string): Promise<WaTemplate[]>;
export async function fetchTemplate(wabaId: string, name: string, language: string): Promise<WaTemplate | undefined>;
export function invalidateTemplateCache(wabaId?: string): void;
export function sendUrl(phoneNumberId: string, endpoint: SendEndpoint): string;

// methods/index.ts
export function splitTemplateValue(value: string): { name: string; language: string };
export const listSearch: { searchTemplates(filter?: string): Promise<INodeListSearchResult> };
export const loadOptions: { getPhoneNumbers(): Promise<INodePropertyOptions[]> };
export const resourceMapping: { getTemplateParameters(): Promise<ResourceMapperFields> };
```

---

## 7. Test fixtures

### 7.0 `test/templates.test.js` — ten template fixtures

Together they exercise every branch of the parser and payload builder.

| # | Fixture | Asserts |
| --- | --- | --- |
| 1 | POSITIONAL, IMAGE header, 3 body vars, dynamic URL button, static QUICK_REPLY | numeric ordering, `{ link }` for a URL media value, quick-reply field present but `removed` |
| 2 | NAMED, TEXT header, coupon button, limited-time offer | `parameter_name` emitted, `lto` lands after the root components |
| 3 | Carousel, 2 cards, per-card header + body + URL button | `card_index`, per-card button indexes, `{ id }` for a numeric media value |
| 4 | AUTHENTICATION with a COPY_CODE OTP button | one field `auth::otp::0` in, two components out with the same code |
| 5 | Validation failure — fill only one of four required vars | message names the count, description lists **short** labels only |
| 6 | Ordering — supply `{{3}}`, `{{1}}`, `{{2}}` out of order | serialises `first, second, third` |
| 7 | Media card carousel with QUICK_REPLY + URL per card | `sub_type:'quick_reply'` with `{ type:'payload', payload }` |
| 8 | MPM template with thumbnail + sections | one `action` object holding both |
| 9 | `PRODUCT` header | `{ type:'product', product:{ product_retailer_id } }` |
| 10 | Zero-tap AUTHENTICATION, no OTP button declared | field ID is plain `auth::otp`, **no** button component emitted |

### 7.1 Expected payload

Fixture 7, verified against Meta's media-card-carousel documentation:

```json
[
  { "type": "body", "parameters": [{ "type": "text", "text": "Pablo" }] },
  { "type": "carousel", "cards": [
    { "card_index": 0, "components": [
      { "type": "header", "parameters": [{ "type": "image", "image": { "id": "1558081531584829" } }] },
      { "type": "button", "index": "0", "sub_type": "quick_reply",
        "parameters": [{ "type": "payload", "payload": "more-aloes" }] },
      { "type": "button", "index": "1", "sub_type": "url",
        "parameters": [{ "type": "text", "text": "blue-elf" }] }
    ] }
  ] }
]
```

---

### 7.2 `test/errors.test.js` — classification and disposition

Each case is `[code, details, endpoint the request went to, expected class, toCloud, toMM, retry]`.

| Code | Went to | Expected class | Disposition |
| --- | --- | --- | --- |
| `131050` opted out | `/marketing_messages` | `opt_out` | `suppress` |
| `130403` user blocked | `/marketing_messages` | `undeliverable` | `suppress` |
| `131026` unreachable | `/messages` | `undeliverable` | `suppress` |
| `131049` per-user cap | `/marketing_messages` | `deferred` | `retry_later`, 24 h |
| `131056` same-recipient flood | `/messages` | `deferred` | `retry_later`, 15 min |
| `131048` sender restricted | `/messages` | `deferred` | `retry_later` |
| `131064` classification enforcement | `/messages` | `deferred` | `retry_later` |
| `4`, `80007` rate limits | `/messages` | `deferred` | `retry_later` |
| `134101` still syncing | `/marketing_messages` | `mm_fallback` | `reroute` → Cloud API |
| `134102` not onboarded | `/marketing_messages` | `mm_fallback` | `reroute` |
| `134100`, `131055` wrong category | `/marketing_messages` | `mm_fallback` | `reroute` |
| `100` must be a template | `/marketing_messages` | `mm_fallback` | `reroute` |
| `100` unsupported parameter | `/messages` | `mm_fallback` | **no reroute** — context matters |
| `131063` marketing disabled | `/messages` | `cloud_marketing_disabled` | `reroute` → MM API |
| `130429`, `131016` | `/messages` | `retryable` | `retry_now` |
| `132000`, `132012` | `/messages` | `template_mismatch` | `fix` |
| `131047` 24 h window, `132016` disabled | `/messages` | `fix_required` | `fix` |
| `190` token expired | `/messages` | `auth` | `fix` |
| `368` account restricted | `/messages` | `integrity` | `fix` |

Plus three assertions that guard the distinction:

- `retryAfterMs` returns exactly 24 h for `131049` and 10 min for `134101` — the two values Meta
  states
- `retryAfterMs` returns `undefined` for `131050`, so an opt-out can never enter a retry loop
- `fbtrace_id` is extracted, and `explainWaError` returns guidance for `131050`

### 7.3 `test/webhook.test.js` — acceptance vs delivery

Built from the exact accept payload the official node returns, plus a realistic status webhook.

| Assertion | Why |
| --- | --- |
| `accepted` normalises to `delivered: false` | Acceptance is queueing, not delivery |
| `message_status` preserved verbatim | Do not invent a status Meta did not send |
| `messageId`, `recipient.waId`, `endpoint`, `template` extracted | The official node exposes none of this |
| Tracking ref generated when absent, respected when supplied | The join key between send and outcome |
| `sent` → `delivered: false` | `sent` means it left Meta, not that it arrived |
| `delivered` → `delivered: true`, `pricingCategory: marketing_lite` | Confirms MM API pricing surfaces |
| Unix timestamp → ISO | Meta sends seconds; workflows want dates |
| Webhook `131049` → `deferred` / `retry_later` / has `retryAfter` | Same classification as the send path |
| Webhook `131050` → `opt_out` / `suppress` / **no** `retryAfter` | An opt-out must never enter a retry loop |
| `href` surfaced from the webhook error | Only webhook errors carry it |
| Bare `value` object parses | Trigger configurations differ |
| Inbound-message webhook is **not** a status webhook | Same `messages` field, different content |
| Account-level `errors[]` beside `statuses` classified | Otherwise silently dropped |

## 8. Coverage matrix

✅ generated and verified · ⚠️ partial · ❌ needs the JSON escape hatch

| Family | Status |
| --- | --- |
| Custom marketing / utility | ✅ |
| Media card carousel | ✅ |
| Coupon code | ✅ |
| Limited-time offer | ✅ |
| Location | ✅ |
| Call permission request | ✅ (body vars only; `VOICE_CALL` takes none) |
| Authentication — copy code | ✅ |
| Authentication — one-tap autofill | ✅ |
| Authentication — zero-tap | ✅ |
| Catalog template | ✅ |
| Multi-product (MPM) | ✅ |
| Single-product (SPM) | ✅ |
| Product card carousel | ✅ |
| Keyboard suggestions | ✅ (no send-time parameters) |
| Tap target URL title override | ✅ (creation-time concern) |
| Order details / order status (Payments IN & BR) | ❌ |
| Checkout button / payment request CTA | ❌ |

Payment templates carry a deep nested action object with currency, line items, tax and shipping —
wide enough to be its own project, and only relevant in India and Brazil. Rather than model it
badly, **Raw Components Override (JSON)** replaces the generated `components` array and **Extra
Components (JSON)** appends to it. Nothing is unsendable; the ❌ rows are hand-written JSON, which
is what an HTTP Request node would have needed anyway — except you keep the template picker,
category routing, status checking and endpoint selection around it.

Unknown future component and button types must degrade to "no fields generated" rather than
throwing, so a template using one still sends.

---

## 9. Out of scope

Do not build without asking:

- a trigger node — the built-in `WhatsApp Trigger` handles webhook registration; `Delivery Status →
  Parse Webhook` consumes its output rather than duplicating it
- media upload as an operation — header media takes a URL or an existing media ID
- template creation, editing or deletion
- payment template modelling — escape hatch only
- MM API onboarding — a Business Manager flow, not an API call

---

## 10. Rules

- No hardcoded Graph API version outside the credential default.
- No Graph call from `execute()` per item except the one cached category lookup.
- Never send `message_activity_sharing` or `message_send_ttl_seconds` to `/messages`.
- Never let a non-MARKETING template reach `/marketing_messages` — fail in n8n instead.
- Every user-facing error names the thing that is wrong: which variable, which template, which
  endpoint. Never surface a bare Meta error code that could have been caught.
- Run `npm test` after any change to `helpers/`.
- Never classify an error on message text where a documented code exists.
