# Design

## The gap

n8n ships a `WhatsApp Business Cloud` node. It sends template messages. It also never reads the
template.

| In `nodes-base/nodes/WhatsApp` | Consequence |
| --- | --- |
| Never requests the template's `components` | Cannot know a template has three variables, so it asks for none and validates nothing |
| Parameters are hand-built `fixedCollection` slots | You count `{{1}}`, `{{2}}`, `{{3}}` against WhatsApp Manager in another tab |
| No awareness of `parameter_format` | Named-parameter templates silently produce invalid payloads — `parameter_name` is never emitted |
| Switching template leaves stale components | The previous template's parameters get sent to the new one |
| Errors surface only from Meta | `(#132000) Number of parameters does not match`, after the workflow ran |
| `/messages` hardcoded, Graph `v13.0` hardcoded | No Marketing Messages API, no version control |
| Returns Meta's accept payload verbatim | A workflow cannot tell a delivered message from one that failed thirty seconds later |

This package closes the first six by reading the template, and the seventh by treating the status
webhook as half of the send.

## Feature 1 — template-aware variable fields

### The mechanism

n8n's `resourceMapper` parameter type renders a form whose shape comes from a node method rather
than from a static property list:

```ts
typeOptions: {
  loadOptionsDependsOn: ['template.value', 'messagingEndpoint'],
  resourceMapper: { resourceMapperMethod: 'getTemplateParameters', mode: 'add', … },
}
```

`loadOptionsDependsOn` is the entire "fields rebuild when you switch template" behaviour. When
`template.value` changes, n8n calls `getTemplateParameters`, which fetches the template, parses its
`components`, and returns one `ResourceMapperField` per variable. Values whose IDs are no longer in
the new schema are dropped.

### Why field IDs carry everything

At execution time n8n hands the node the mapper's stored `schema` plus the user's `value` object —
and nothing else. Not the template, not which component a value came from, not the button index.

So all of it lives in the ID:

```
h::text::<key>                 header text variable
h::media::<image|video|document>
h::media_filename              document filename
h::loc::<latitude|longitude|name|address>
h::product::<product_retailer_id|catalog_id>
b::text::<key>                 body text variable
btn::<i>::url::<key>           dynamic URL suffix
btn::<i>::quick_reply_payload
btn::<i>::copy_code
btn::<i>::flow_token · flow_action_data
btn::<i>::catalog_thumbnail
btn::<i>::mpm_thumbnail · mpm_sections
lto::expiration_time_ms
auth::otp[::<otpButtonIndex>]
card::<c>::<any of the above>  scoped to carousel card c
```

Separator `::`. The consequence is the point: **`buildTemplateObject` makes zero network calls.** A
campaign sending 50 000 messages does one cached template lookup for the category, not 50 000
lookups to work out what `{{2}}` meant.

It also means renaming anything in this grammar is a **breaking change**. n8n stores these IDs inside
saved workflows; existing nodes would lose their values.

### Digit-only means positional

Meta requires named parameters to be lowercase letters, digits and underscores, and never all-digits.
So `/^\d+$/` on the key is the whole test:

- `b::text::1` → `{ type: 'text', text: 'Ravi' }`
- `b::text::customer_name` → `{ type: 'text', text: 'Priya', parameter_name: 'customer_name' }`

Positional parameters are sorted **numerically** before serialisation. Meta matches body parameters
by array position, so a user who fills `{{3}}` before `{{1}}` would otherwise get their values
transposed with no error at all.

### The field heading

```
Body · {{2}} · …Hi Ravi, your order #⟨2⟩ ships on {{3}}…  (e.g. A-8823)
```

Three pieces of information, because a body with four variables otherwise gives four
indistinguishable inputs:

1. **Which variable** — `{{2}}` for positional, `customer_name` for named.
2. **Where it lands** — ±24 characters of the approved copy, with the target rendered as `⟨2⟩` so it
   is visually distinct from neighbours still shown as `{{…}}`.
3. **Meta's own example** — pulled from the template's `example` block.

Meta ships three different example shapes (`header_text`, `body_text` as an array *of arrays*, and
`*_named_params` as `{ param_name, example }` objects). `exampleFor()` normalises all three in one
place.

## Feature 2 — send endpoint selection

Meta has two send endpoints. The official node knows about one.

| | `/messages` | `/marketing_messages` |
| --- | --- | --- |
| Message types | all | template only |
| Template categories | all | MARKETING only |
| `message_send_ttl_seconds` for marketing | not supported | supported |
| `message_activity_sharing` (click webhooks) | not supported | supported |
| Prerequisite | none | MM API Terms of Service accepted at business-portfolio level |
| Delivery | standard | Meta optimises recipients and timing |
| Pricing category on the webhook | `marketing` | `marketing_lite` |

Payloads are otherwise identical, and **webhooks are identical** — which is why this package ships no
trigger node. The built-in `WhatsApp Trigger` keeps working for both.

### Routing

| Send Via | Category | Result |
| --- | --- | --- |
| `auto` | MARKETING | `/marketing_messages` |
| `auto` | anything else | `/messages` |
| `messages` | any | `/messages` |
| `marketing_messages` | MARKETING | `/marketing_messages` |
| `marketing_messages` | anything else | **throws inside n8n**, naming the actual category |

The last row matters: letting a UTILITY template reach `/marketing_messages` produces a Meta error
code the user has to go and look up. Failing before the request leaves n8n names the problem.

Selecting the MM API also filters the template picker to marketing templates, so the restriction is
visible before anything is sent.

## Delivery outcomes

Both endpoints answer a successful send with:

```json
{ "messages": [{ "id": "wamid.HBgMOTE5…", "message_status": "accepted" }] }
```

`accepted` means queued. It is not delivery, it does not say which endpoint was used, and it carries
no key for correlating the eventual outcome.

So the node:

- normalises the send result to `{ delivered: false, status, messageId, recipient, endpoint,
  routedVia, template, trackingRef, sentAt }`, with `delivered` hard-coded false — only a webhook can
  set it true
- generates `biz_opaque_callback_data` when the user does not supply one, as the join key between a
  send and its status webhook once a workflow fans out across recipients
- adds **Delivery Status → Parse Webhook**, which turns the trigger's output into classified events
  using the *same* error mapping as the send path

`delivered` is true only for `delivered` and `read`. `sent` means it left Meta — conflating the two
is what makes delivery dashboards lie.

## Architecture

```
nodes/WhatsAppAdvanced/
├── WhatsAppAdvanced.node.ts   execute(), endpoint routing, retry and fallback
├── descriptions/index.ts      all INodeProperties
├── transport/index.ts         Graph requests, template cache
├── methods/index.ts           listSearch · loadOptions · resourceMapping
└── helpers/
    ├── interfaces.ts
    ├── errors.ts              code → class → disposition
    ├── response.ts            accept payload → normalised send result
    ├── webhook.ts             status webhook → classified delivery events
    ├── templateParser.ts      template → ResourceMapperField[]      FEATURE 1a
    └── payloadBuilder.ts      values → template.components          FEATURE 1b
```

The five `helpers/` modules are **pure** — no `this`, no network, no n8n context. That is what makes
95 assertions runnable with plain `node` and no n8n instance.

**Programmatic node style** (`async execute()`), not declarative `routing`. Declarative cannot express
"call a method to decide the form's shape" or "retry a different endpoint on a specific error code",
and both are load-bearing here.

**`transport/` rethrows Meta's original error** rather than wrapping it in `NodeApiError`.
Classification needs the untouched envelope; wrapping happens at the call site via `toNodeError`.

**The template cache** is a module-level `Map` with a 60-second TTL, keyed by
`${wabaId}:${nameFilter}`. Without it the resource mapper makes one Graph call per keystroke in the
picker.

### Auto-map

With **Map Automatically** selected, n8n leaves the mapper's `value` null and hands the node the
incoming item to resolve itself. Field IDs are internal (`b::text::customer_name`) and no upstream
system produces them, so each field is matched against two keys, in order:

1. the full field ID, for items already shaped for this node
2. the variable's own name — `customer_name`, `copy_code`, `otp`, `latitude`

Positional variables are deliberately excluded from the second rule: an incoming property called `1`
lining up with `{{1}}` is a coincidence, not a mapping, and silently sending the wrong value is worse
than asking for it. Positional templates auto-map only on the full field ID.

One consequence worth knowing: in a carousel, `card::0::b::text::discount` and
`card::1::b::text::discount` share the natural key `discount`, so an item carrying a single
`discount` fills every card with the same value. Give the item field-ID keys to drive cards
separately.

## Limitations

- **Payment templates need the JSON escape hatch.** See `COVERAGE.md`.
- **No media upload.** Header media takes a public URL or an already-uploaded media ID.
- **No template creation, editing or deletion.** Read-only against WhatsApp Manager.
- **Community nodes are self-hosted only** unless the package passes n8n's verification review.
- **MM API onboarding is a Business Manager flow**, not an API call. Until it is done, `Auto` plus the
  fallback keeps sends working.
- **Renaming a field ID breaks saved workflows.** Anything in the grammar above is a major version.
