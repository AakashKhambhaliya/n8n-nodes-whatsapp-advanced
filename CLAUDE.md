# CLAUDE.md

Context for Claude Code working in this repository.

## What this is

`n8n-nodes-whatsapp-advanced` — an n8n community node for the WhatsApp Business Platform. Two
headline features; everything else exists to serve them:

1. **Template-aware variable fields.** Picking an approved template generates one labelled input per
   template variable, via n8n's `resourceMapper`.
2. **Send-endpoint selection.** Cloud API `/messages`, Marketing Messages API `/marketing_messages`,
   or automatic routing by template category.

Full rationale in `DESIGN.md`. Full build spec in `BUILD-PLAN.md`. Error mapping in `ERRORS.md`.
Template support in `COVERAGE.md`.

## Commands

```bash
npm run build     # rimraf dist .tsbuildinfo && tsc && gulp build:icons
npm run lint      # eslint-plugin-n8n-nodes-base — must stay clean
npm test          # builds, then runs all four suites
npm run dev       # tsc --watch
```

Tests require from `dist/`, so **always build before running a suite directly**:

```bash
npm run build && node test/templates.test.js
```

## Layout

```
credentials/WhatsAppAdvancedApi.credentials.ts
nodes/WhatsAppAdvanced/
  WhatsAppAdvanced.node.ts    execute(), routing, retry, fallback
  descriptions/index.ts       all INodeProperties
  transport/index.ts          Graph requests + template cache
  methods/index.ts            listSearch · loadOptions · resourceMapping
  helpers/                    pure modules — see below
test/                         plain node, no n8n, no network
```

`helpers/templateParser.ts`, `payloadBuilder.ts`, `errors.ts`, `response.ts` and `webhook.ts` are
**pure**: no `this`, no network, no n8n context. Keep them that way — it is what makes the test
suites runnable without an n8n instance.

## Locked decisions

Do not change these without asking. Each is load-bearing.

- **Field IDs encode component, sub-type and position** (`b::text::2`, `card::1::btn::0::url::1`).
  n8n hands `execute()` only the stored schema and values, so nothing else can carry that
  information. Renaming any part of the grammar breaks saved workflows — it is a major version.
- **`/^\d+$/` on the key decides `parameter_name`.** Digit-only is positional; anything else is
  named.
- **Positional parameters sort numerically** before serialisation.
- **`loadOptionsDependsOn: ['template.value', 'messagingEndpoint']`** is the entire mechanism behind
  "fields rebuild when the template changes". Do not remove it, and do not rename `template` or
  `messagingEndpoint` without updating it.
- **Errors are classified by numeric code, never by message text.** Meta rewords strings and returns
  localised copy.
- **`transport/` rethrows Meta's original error.** Wrapping happens at the call site via
  `toNodeError`; classification needs the untouched envelope.
- **`131050` (opt-out) never gets a retry hint and is never replayed.** `131049` (frequency cap) is
  deferred with a 24-hour wait — the recipient did not refuse. Conflating them destroys paid-for
  messages.
- **`100` is context-dependent.** A fallback signal only when the request went to
  `/marketing_messages`.
- **Quick-reply buttons generate a field** (optional payload), shown up front inside a carousel card
  and hidden behind *Add variable* otherwise.
- **Zero-tap authentication emits no button component.** `auth::otp` without an index is the signal.
- **`delivered` is false on every send.** `accepted` means queued. Only `delivered` and `read` on the
  status webhook set it true — never `sent`.

## Rules

- No hardcoded Graph API version outside the credential default (`v23.0`).
- No Graph call from `execute()` per item except the one cached category lookup.
- Never send `message_activity_sharing` or `message_send_ttl_seconds` to `/messages`.
- Never let a non-MARKETING template reach `/marketing_messages` — fail inside n8n instead.
- Every user-facing error names the thing that is wrong: which variable, which template, which
  endpoint.
- Run `npm test` after any change to `helpers/`.
- Unknown component and button types must degrade to "no fields generated", never throw.

## Out of scope

Do not build without asking: a trigger node (the built-in `WhatsApp Trigger` handles webhook
registration), media upload as an operation, template creation/editing/deletion, payment template
modelling (escape hatch only), MM API onboarding.
