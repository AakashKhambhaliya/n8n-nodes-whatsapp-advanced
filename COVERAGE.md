# Template coverage

✅ generated and verified · ⚠️ partial · ❌ needs the JSON escape hatch

| Family | Status |
| --- | --- |
| Custom marketing / utility | ✅ |
| Media card carousel | ✅ |
| Coupon code | ✅ |
| Limited-time offer | ✅ |
| Location | ✅ |
| Call permission request | ✅ (body variables only; `VOICE_CALL` takes none) |
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

## What each family generates

| Component | Field IDs | Emitted parameter |
| --- | --- | --- |
| `HEADER` `TEXT` | `h::text::<key>` | `{ type: 'text', text }` (+ `parameter_name` when named) |
| `HEADER` `IMAGE`/`VIDEO`/`DOCUMENT` | `h::media::<kind>`, `h::media_filename` | `{ type: 'image', image: { link \| id } }` |
| `HEADER` `LOCATION` | `h::loc::latitude` · `longitude` · `name` · `address` | `{ type: 'location', location: {…} }` |
| `HEADER` `PRODUCT` | `h::product::product_retailer_id` · `catalog_id` | `{ type: 'product', product: {…} }` |
| `BODY` | `b::text::<key>` | `{ type: 'body', parameters: [...] }` |
| `FOOTER` | — | none |
| `BUTTONS` → `URL` | `btn::<i>::url::<key>` | `sub_type: 'url'`, `{ type: 'text', text }` |
| `BUTTONS` → `QUICK_REPLY` | `btn::<i>::quick_reply_payload` | `sub_type: 'quick_reply'`, `{ type: 'payload', payload }` |
| `BUTTONS` → `COPY_CODE` | `btn::<i>::copy_code` | `sub_type: 'copy_code'`, `{ type: 'coupon_code', coupon_code }` |
| `BUTTONS` → `FLOW` | `btn::<i>::flow_token`, `btn::<i>::flow_action_data` | `sub_type: 'flow'`, one `action` object |
| `BUTTONS` → `CATALOG` | `btn::<i>::catalog_thumbnail` | `sub_type: 'catalog'`, one `action` object |
| `BUTTONS` → `MPM` | `btn::<i>::mpm_sections`, `btn::<i>::mpm_thumbnail` | `sub_type: 'mpm'`, one `action` object holding both |
| `BUTTONS` → `PHONE_NUMBER` / `VOICE_CALL` / `OTP` | — | none |
| `CAROUSEL` | `card::<c>::` + any of the above | `{ type: 'carousel', cards: [{ card_index, components }] }` |
| `LIMITED_TIME_OFFER` | `lto::expiration_time_ms` (only when `has_expiration`) | `{ type: 'limited_time_offer', parameters: […] }` |
| category `AUTHENTICATION` | `auth::otp[::<i>]` — exactly one field | body parameter, plus a `sub_type: 'url'` button when an OTP button is declared |

## Notes on the harder cases

**A static URL button generates no field.** Only a URL containing `{{1}}` takes a parameter; asking
for a value on a fixed link would be a lie about what gets sent.

**Media fields accept either form.** A value starting `http://` or `https://` serialises as
`{ link }`, anything else as `{ id }`. One field, both cases, no toggle.

**Document filenames ride with their media field.** `h::media_filename` is skipped in the main loop
and folded into the `document` object.

**Authentication templates ask once.** Meta fixes the copy, so the only value is the code — and it
goes in two places at once. Zero-tap declares no OTP button, which is why the button index is part
of the field ID: `auth::otp::0` emits the button, plain `auth::otp` does not.

**Quick-reply payloads are optional but visible inside a carousel.** Meta's carousel documentation
puts one on every card, so inside a card the field shows up front; on a standalone template it stays
behind *Add variable*.

**MPM needs `sections`.** A thumbnail alone sends an empty product list. `sections` and the thumbnail
merge into a single `action` object.

## Why payment templates are ❌

Order details and order status templates carry a deeply nested action object — currency, line items,
tax, shipping, discounts, expiry, payment configuration. Modelling that well is its own project, and
it is only relevant in India and Brazil.

Rather than model it badly:

- **Raw Components Override (JSON)** replaces the generated `components` array entirely
- **Extra Components (JSON)** appends to it

Nothing is unsendable. The ❌ rows are hand-written JSON — which is what an HTTP Request node would
have needed anyway, except here you keep the template picker, category routing, status checking,
endpoint selection, error classification and delivery correlation around it.

## Forward compatibility

An unknown component type, header format or button type generates **no fields** rather than throwing.
A template using something Meta ships next year still sends; its extra parameters go through the
escape hatch until this package models them.
