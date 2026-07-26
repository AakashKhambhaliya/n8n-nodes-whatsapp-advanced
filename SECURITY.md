# Security

## Reporting a vulnerability

Open a [security advisory](https://github.com/AakashKhambhaliya/n8n-nodes-whatsapp-advanced/security/advisories/new)
rather than a public issue. Please include the node version, the n8n version and a reproduction.

## Supported versions

The latest published minor. Fixes ship as a new patch release; there is no backporting to earlier
minors.

## What this package handles

**Zero runtime dependencies.** The published tarball contains compiled JavaScript, the node icon,
the README and the licence — nothing else. Only `n8n-workflow`, a peer dependency n8n already
provides, is required at run time. There is no supply chain below this package to audit.

**The access token is never read by node code.** The credential declares an
`IAuthenticateGeneric` block and n8n injects `Authorization: Bearer …` into each request itself.
No file in `nodes/` or `credentials/` reads `credentials.accessToken` for any purpose other than
deriving a non-reversible cache fingerprint (below). Grep for it.

**Errors are rebuilt, not forwarded.** A failed HTTP request carries its whole request context,
including the `Authorization` header. `toNodeError` constructs a fresh envelope from the parsed
fields — code, type, `error_data.details`, `fbtrace_id` — and hands *that* to `NodeApiError`, so the
object n8n stores on the execution and renders in the UI cannot contain the token. The current
`n8n-workflow` discards the original anyway, but the peer range is `*` and that is a behaviour to
design against rather than depend on. Covered by `test/security.test.js`.

**The template cache is namespaced per credential.** The cache is module-level, so it is shared by
every workflow and every user in one n8n process. Its key includes a truncated SHA-256 of the access
token, which means a second tenant who merely knows a business account ID is not served another
tenant's cached template copy without their own token being checked. Rotating a token changes the
fingerprint and drops the old entries.

**Graph API identifiers are validated.** Business account IDs, phone number IDs and the version
string must match `[A-Za-z0-9._-]+`. The request host cannot be changed through them — the authority
is fixed before any of it is appended — but a `?`, `#` or `/` would silently move the request
elsewhere on `graph.facebook.com` and return an opaque Meta error. It is rejected by name instead.

## What this package does *not* protect against

These are properties of how the node is wired into a workflow. Read them before deploying.

### Webhook payloads are trusted as given

`Delivery Status → Parse Webhook` classifies whatever JSON it is handed. **It does not verify Meta's
`X-Hub-Signature-256`** — it cannot, because the raw request body is consumed by whichever node
received the webhook.

Use the built-in **WhatsApp Trigger**, which registers with Meta and verifies signatures. If you
instead point a generic Webhook node at a public URL and feed it into this operation, anyone who
learns that URL can inject delivery events — for example a fabricated `131050`, which classifies as
`opt_out` and would have a downstream workflow suppress a customer who never opted out.

### The node can send messages, and it is exposed to AI agents

`usableAsTool` is enabled, so an n8n AI Agent can call this node. An agent that processes untrusted
input — inbound customer messages, scraped pages, forwarded email — can be prompt-injected into
sending WhatsApp messages to attacker-chosen recipients, with attacker-chosen template variables,
billed to your account.

If the node is reachable by an agent, constrain what the agent can be told and who it can message.
Nothing in this package limits recipients.

### The tracking reference is sent to Meta

`biz_opaque_callback_data` is generated as `n8n:{executionId}:{itemIndex}:{templateName}` and is
transmitted to Meta, stored by them and echoed back on the status webhook. Anything you put in the
**Tracking Reference** option goes the same way. Do not put customer identifiers or anything else
you would not hand to a third party in that field.

### Raw component overrides are unchecked by design

**Raw Components Override** and **Extra Components** inject arbitrary JSON into the Graph API
payload. This is the documented escape hatch for payment templates and is not validated. It grants
no more than the credential already allows — a workflow author can reach the same API through an
HTTP Request node — but it is not a boundary.

### Community nodes run with full n8n privileges

n8n community nodes execute as part of the n8n process, with its filesystem and network access. That
is true of every community node. Install from npm only, verify the version, and read the source if
your threat model calls for it — the published `dist/` is compiled from the TypeScript in this
repository with no minification.

## Verifying what you installed

```bash
npm view n8n-nodes-whatsapp-advanced dist.integrity
npm pack n8n-nodes-whatsapp-advanced && tar -tzf n8n-nodes-whatsapp-advanced-*.tgz
```

The tarball should contain `dist/`, `index.js`, `LICENSE`, `README.md` and `package.json`. Anything
else does not belong there.
