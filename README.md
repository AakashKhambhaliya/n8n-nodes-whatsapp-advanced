# n8n-nodes-whatsapp-advanced

A WhatsApp Business node for n8n that reads your approved templates and builds the input form
from them, and that can send through either of Meta's two send endpoints.

Full design rationale, data flow and API notes: **[DESIGN.md](./DESIGN.md)**

## The two headline features

### 1. Template variables are fetched, not typed

Pick a template. The node calls `GET /{WABA_ID}/message_templates`, parses the returned
`components`, and renders one labelled input per variable:

```
Template   ✅ order_update — en_US · UTILITY · 4 variables       ▾

Header · image (public URL or uploaded media ID)                 [                    ]
Body · {{1}}  ·  Hi ⟨1⟩, your order #{{2}} ship…  (e.g. Ravi)    [                    ]
Body · {{2}}  ·  …your order #⟨2⟩ ships on {{3}}…  (e.g. A-8823) [                    ]
Button 1 "Track order" · URL suffix ⟨1⟩  ·  https://shop…/{{1}}  [                    ]
```

Each heading names the variable, shows where it lands in the approved copy, and carries Meta's own
example value. Switch template and the fields rebuild for the new one.

Also handled: named parameters (`{{customer_name}}` with `parameter_format: NAMED`), media and
location headers, coupon-code buttons, WhatsApp Flows, limited-time offers, carousel cards, and
authentication templates (one OTP field, fanned out into both places Meta requires).

Auto-map is supported — if the incoming item already has a `customer_name` field, it fills the
`{{customer_name}}` slot with no wiring.

### 2. Choose your send endpoint

```
Send Via   ○ Auto — route by template category      (default)
           ○ Cloud API — /messages
           ○ Marketing Messages API — /marketing_messages
```

`Auto` sends MARKETING templates to `/marketing_messages` for Meta's delivery optimisation, TTL
and click webhooks, and everything else to `/messages`. Selecting the MM API filters the template
dropdown to marketing templates only, and `Fall Back to Cloud API` (on by default) retries against
`/messages` if Meta reports the account or template as ineligible.

### 3. Delivery outcomes, not just acceptances

The official node returns Meta's raw accept payload and stops:

```json
{ "messages": [{ "id": "wamid.HBgMOTE5…", "message_status": "accepted" }] }
```

`accepted` means queued. It is not delivery, and almost every error code you care about —
`131049`, `131050`, `131026` — arrives minutes later on the webhook instead.

This node normalises the send result and adds a **Delivery Status → Parse Webhook** operation that
turns the built-in WhatsApp Trigger's output into classified events using the same error mapping
the send path uses:

```
send     → { delivered: false, status: "accepted", messageId, trackingRef, endpoint, template }
webhook  → { delivered: false, status: "failed", code: 131049,
             disposition: "retry_later", retryAfter: "…", trackingRef }
```

`trackingRef` is the join key, generated automatically. `delivered` is true only for `delivered`
and `read` — never for `sent`.

## Also included

- Pre-send validation: names the missing variables instead of surfacing `(#132000)`
- Refuses to send templates that are not `APPROVED`
- `Validate Only (Dry Run)` outputs the assembled payload and a rendered preview without sending
- `Template → List` / `Template → Get` operations that return parsed variables and a preview
- Searchable sender-number and template pickers
- Graph API version is a credential field, not a hardcoded constant

## Install

**From n8n (recommended)** — Settings → Community nodes → Install → `n8n-nodes-whatsapp-advanced`

**Self-hosted, manually**

```bash
cd ~/.n8n/custom
npm install n8n-nodes-whatsapp-advanced
```

Restart n8n. Requires n8n with Node.js 20.15 or later.

**From source**

```bash
git clone https://github.com/AakashKhambhaliya/n8n-nodes-whatsapp-advanced
cd n8n-nodes-whatsapp-advanced
npm install && npm run build && npm link
cd ~/.n8n/custom && npm link n8n-nodes-whatsapp-advanced
```

> Community nodes are not available on n8n Cloud unless verified. Self-hosted works today.

## Setup

Credential (**WhatsApp Advanced API**):

| Field | Where to get it |
| --- | --- |
| Access Token | Meta app → system user token with `whatsapp_business_messaging` and `whatsapp_business_management` |
| Business Account ID | WhatsApp Manager → account settings, or Meta app → WhatsApp → API Setup |
| Graph API Version | defaults to `v23.0` |

## Development

```bash
npm install
npm run build     # rimraf dist .tsbuildinfo && tsc && gulp build:icons
npm run lint
npm test          # builds, then runs all four suites
npm run dev       # tsc --watch
```

## Tests

136 assertions, no n8n instance and no network.

| Suite | Covers |
| --- | --- |
| `test/templates.test.js` | Parser and payload builder against positional, named, carousel, limited-time-offer, MPM and authentication templates, asserting the generated Graph API bodies |
| `test/errors.test.js` | Every error code → class → disposition, both fallback directions, and the traps around `131049` vs `131050` |
| `test/webhook.test.js` | Acceptance versus delivery, tracking refs, and status-webhook classification |
| `test/routing.test.js` | Drives the real `execute()` against a fake n8n context: endpoint routing, retries, both fallbacks, non-delivery handling |

```bash
npm run build && node test/templates.test.js
```

## Notes

- Keep using the built-in **WhatsApp Trigger** for inbound messages — the webhook format is the
  same for both endpoints.
- The MM API requires accepting Meta's Marketing Messages Terms of Service at the business
  portfolio level. Until that is done, `Auto` mode plus the fallback keeps sends working.

## Docs

| File | Contents |
| --- | --- |
| `DESIGN.md` | Gap analysis vs the official node, the resource-mapper mechanism, field-ID grammar, architecture |
| `COVERAGE.md` | Which WhatsApp template types are supported, with the exact payload for each |
| `ERRORS.md` | Error code → class → disposition mapping, both fallback directions, webhook handling |
| `BUILD-PLAN.md` | Phase-by-phase implementation plan (for contributors and AI agents) |
| `CLAUDE.md` | Auto-loaded context for Claude Code |
| `CHANGELOG.md` | Release notes |
| `PUBLISHING.md` | Release checklist, versioning policy, n8n Cloud verification notes |

## Contributing

Issues and PRs welcome. `npm run lint && npm test` must pass; `helpers/` is pure and unit-tested,
so behaviour changes there need a test case.

## License

[MIT](./LICENSE)
