# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-07-26

Initial release.

### Template-aware variable fields

- Selecting an approved template generates one labelled input per variable, using n8n's
  `resourceMapper`. The field heading names the variable, shows where it lands in the approved copy,
  and carries Meta's own example value.
- Changing the template rebuilds the fields; orphaned values are dropped.
- `parameter_format` aware — `parameter_name` is emitted for `NAMED` templates and omitted for
  `POSITIONAL` ones, which the official node gets wrong.
- Auto-map: an incoming item property named `customer_name` fills the `{{customer_name}}` slot with
  no wiring.
- Covers text, media, location and product headers; body variables; URL, quick-reply, coupon, Flow,
  catalog and multi-product buttons; carousels; limited-time offers; and all three authentication
  template types.
- Pre-send validation names the missing variables instead of surfacing Meta's `#132000`.
- `Validate Only (Dry Run)` returns the assembled payload and a rendered preview without sending.

### Endpoint selection

- **Send Via**: Cloud API `/messages`, Marketing Messages API `/marketing_messages`, or **Auto**,
  which routes MARKETING templates to the MM API and everything else to Cloud API.
- Selecting the MM API filters the template dropdown to marketing templates.
- `message_activity_sharing` and `message_send_ttl_seconds` are attached only on the MM API.

### Error handling

- Classification by documented Meta error code, never by message text.
- Five dispositions: `retry_now`, `retry_later`, `reroute`, `suppress`, `fix`.
- Meta-side throttles (`131049`, `131056`, `131048`, `131064`, `4`, `80007`) are **deferred** and
  re-queueable, not treated as refusals. Only `131050` — a genuine opt-out — is suppressed, and it
  never carries a retry hint.
- Bidirectional endpoint fallback: MM API → Cloud API on `134101`/`134102`/`131055`/`134100`, and
  Cloud API → MM API on `131063`.
- Exponential backoff for transient failures; hour-scale limits fail fast with an explanation.
- Errors carry Meta's `details`, node guidance, and the `fbtrace_id` needed for a support ticket.

### Delivery outcomes

- Send results are normalised: `delivered`, `status`, `messageId`, `recipient`, `endpoint`,
  `routedVia`, `template`, `trackingRef`, `sentAt`. `delivered` is always `false` on a send —
  `accepted` means queued.
- `biz_opaque_callback_data` is generated automatically as the join key between a send and its
  eventual status webhook.
- **Delivery Status → Parse Webhook** turns the built-in WhatsApp Trigger's output into classified
  events using the same error mapping as the send path. `delivered` is true only for `delivered`
  and `read` — never for `sent`.

### Other

- Graph API version is a credential field (default `v23.0`), not a hardcoded constant.
- Searchable template and phone-number pickers with status, category and variable count.
- `Template → List` and `Template → Get` return parsed variables and a rendered preview.
- Raw Components Override and Extra Components escape hatches for payment templates.
