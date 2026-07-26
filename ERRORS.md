# Error handling

Every decision in this node keys off Meta's numeric `code`. Never off message text: Meta rewords
strings between Graph versions, is deprecating the titles embedded in `message`, and returns
localised copy on non-English business accounts. `error_data.details` is used only to disambiguate
codes Meta reuses.

`error_subcode` is not used at all — it is deprecated and absent from v16.0+ responses.

## Where errors come from

Two places, with different shapes, normalised to one `WaError`:

| Source | Shape | Carries |
| --- | --- | --- |
| HTTP send response | `{ error: { message, type, code, error_data: { details }, fbtrace_id } }` | `type`, `fbtrace_id` |
| `statuses[].errors[]` on the webhook | `{ code, title, error_data: { details }, href }` | `title`, `href` |

`parseWaError` accepts both, plus the several depths n8n's HTTP helper, `NodeApiError` and raw axios
failures bury the envelope at.

**Most error codes are only ever visible on the webhook.** `131049`, `131050`, `131026` and the rest
arrive in `statuses[].errors[]` minutes after a send that returned `200 accepted`. That is why the
**Delivery Status → Parse Webhook** operation runs the same classifier as the send path — a failure
looks identical whichever half surfaced it.

## Class → disposition

| Class | Codes | Disposition | Meaning |
| --- | --- | --- | --- |
| `retryable` | 1, 2, 130429, 131000, 131016, 131057, 133004, 2494100 | `retry_now` | Transient Meta-side failure |
| `deferred` | 131049, 131056, 131048, 131064, 4, 80007, 133016 | `retry_later` | Meta declined *right now* |
| `mm_fallback` | 100, 131009, 131055, 134100, 134101, 134102 | `reroute` → `/messages` | MM API will not take this |
| `cloud_marketing_disabled` | 131063 | `reroute` → `/marketing_messages` | Cloud API will not take this |
| `opt_out` | 131050 | `suppress` | The recipient refused |
| `undeliverable` | 130403, 131021, 131026 | `suppress` | It cannot arrive at all |
| `template_mismatch` | 132000, 132001, 132012 | `fix` | The payload does not match the template |
| `fix_required` | 131042, 131045, 131047, 132007, 132015, 132016, 132018, 133010, 134011 | `fix` | Account or template configuration |
| `auth` | 0, 3, 10, 190, 200–299, 131005 | `fix` | Token or permission |
| `integrity` | 368, 130497, 131031 | `fix` | Policy action on the account |

`134101` appears in both the deferred and the fallback list. It classifies as `mm_fallback`, because
rerouting delivers the message now while deferring only delays it — but `retryAfterMs` still returns
Meta's stated 10 minutes, so a workflow that chooses to wait instead gets the right number.

## Retry waits

| Code | Wait | Source |
| --- | --- | --- |
| `131049` | 24 hours | **Meta-stated** |
| `134101` | 10 minutes | **Meta-stated** |
| `131056`, `4`, `80007` | 15 minutes | node default |
| `131048`, `131064`, `133016` | 24 hours | node default |

`isMetaStatedWait(error)` reports which is which. Meta documents the restriction for the node-default
rows without giving a duration; those numbers are this package's guess and are labelled as such in
`helpers/errors.ts`.

`retryAfterMs` returns `undefined` for everything else — **including `131050`**. An opt-out with a
retry hint would be picked up by a Wait node and resent, which is exactly what Meta says not to do.

## The distinction that matters most

`131049` and `131050` look similar and behave nothing alike.

| | `131049` | `131050` |
| --- | --- | --- |
| What happened | Meta's per-user marketing frequency cap | The recipient opted out |
| Did the recipient refuse? | **No** | Yes |
| Meta's guidance | *"wait at least 24 hours before resending"* | Do not retry |
| This node | `deferred` · `retry_later` · `_retryAfter` ≈ 24 h | `opt_out` · `suppress` · **no** `_retryAfter` |

Putting both in one "do not retry" bucket silently discards paid-for messages the recipient still
wants. The same applies to `131056`, `131048`, `131064`, `4` and `80007`.

## Fallback, in both directions

```
/marketing_messages ──100, 131009, 131055, 134100, 134101, 134102──▶ /messages
/messages ──────────────────────────────131063───────────────────▶ /marketing_messages
```

Two rules govern it:

1. **Direction depends on where the request went.** `100` means "Message must be a template message"
   on the MM API and "unsupported parameter" on Cloud API. It is a routing signal only in the first
   case, so `shouldFallbackToCloudApi(error, sentTo)` checks the endpoint, not just the code.
2. **`opt_out`, `undeliverable`, `template_mismatch`, `fix_required`, `auth` and `integrity` never
   fall back.** Replaying those elsewhere fails identically.

The replayed body drops `message_activity_sharing` and `message_send_ttl_seconds` when going
MM API → Cloud API; those two fields exist only on the MM API.

Every fallback annotates its output:

```json
{ "_routedVia": "messages", "_fallbackFrom": "marketing_messages",
  "_fallbackCode": 134101, "_fallbackReason": "Template is not yet synced…" }
```

`134101` is the common one in practice — a marketing template takes up to 10 minutes to sync to the
linked ad account after approval. Without this fallback, the first ten minutes of a campaign silently
drop.

## Non-delivery is not an exception

A message Meta declined to deliver right now is not the same as a request the node got wrong.
Throwing on the first kind destroys messages the recipient never refused, so with
**Non-Delivery Handling** left at its default the node emits a marked item instead:

```json
{ "_delivered": false, "_disposition": "retry_later", "_errorClass": "deferred",
  "_code": 131049, "_reason": "…", "_guidance": "…",
  "_retryAfterMs": 86400000, "_retryAfter": "2026-07-27T11:04:00.000Z",
  "_recipient": "919824352916", "_templateName": "summer_sale",
  "_trackingRef": "n8n:4821:0:summer_sale", "_fbtraceId": "AbCdEfGhIjK" }
```

`_retryAfter` is absent for `suppress`, so a retry loop cannot pick up an opt-out.

Inline retries run first, with exponential backoff capped at 8 s and `Max Retries` attempts. Once
they are exhausted, a `retryable` code is downgraded to `deferred` — it stopped being a "try again in
a second" problem the moment the retries ran out.

Two more downgrades protect messages that would otherwise be thrown away:

- **A fallback that itself fails** does not escape. Its error replaces the original and goes through
  the same classification, so an MM API `134101` that reroutes to Cloud API and meets `131049` there
  ends up deferred, not thrown.
- **A reroute that never happened** — `Fall Back to Cloud API` switched off — downgrades to
  `deferred` when the code has a documented wait. `134101` defers ten minutes rather than failing
  the item. Codes with no documented wait, like `134102` (account not onboarded), still throw: a
  human has to accept the Terms of Service, and retrying would loop forever.

## Errors the node prevents rather than handles

These never reach Meta:

| Would have been | Prevented by |
| --- | --- |
| `132000` number of parameters does not match | Pre-send validation naming the missing variables |
| `132001` template does not exist | The picker only offers templates on this account |
| Sending a `PAUSED` or `REJECTED` template | Status check before the request leaves n8n |
| `131055` non-marketing template on the MM API | `resolveEndpoint` throws, naming the actual category |
| Invalid `parameter_name` on a positional template | `isPositionalKey` decides per variable |

## Unknown codes

A code this package has not seen classifies as `unknown` with disposition `unknown`, and surfaces
Meta's own message, `details` and `fbtrace_id` untouched. It is never guessed at from the message
text, and it is never silently retried.
