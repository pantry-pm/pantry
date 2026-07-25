# Paid packages

Publish a package, put a price on it, get paid. A buyer pays once, and the
purchase belongs to their **account** — every machine they sign in from can
install it, and rotating a token doesn't cost them what they bought.

The package's metadata stays public. That's deliberate: the page is where
someone reads what a package does and decides to buy it. What's gated is the
tarball.

## For publishers

### 1. Get an account and publish

```bash
# Sign up at https://pantry.dev/signup, then store a token
pantry token set
pantry publish
```

### 2. Set a price

```bash
pantry price set my-package 9.00
```

`9`, `9.00` and `$9.00` all mean the same thing; anything that isn't a price is
refused rather than guessed at. The minimum is $1.00 — below that, card fees eat
the sale.

```bash
pantry price show my-package     # what it costs, and whether you own it
pantry price rm my-package       # give it away again
```

Only the account that published a package can price it. A publish token is
permission to upload *your* packages, not authority over someone else's.

Useful extras:

```bash
# Keep older versions free — a paid 2.x with a free 1.x
pantry price set my-package 29.00 --free-versions 1.0.0,1.1.0

# Charge in another currency
pantry price set my-package 25.00 --currency eur

# Be paid out directly, rather than settling on the registry's account
pantry price set my-package 9.00 --payout-account acct_1234567890
```

You never have to buy your own package: the publisher and the registry operator
can always download it.

### Removing a price

`pantry price rm` makes a package free again. Existing purchases keep working —
you can't un-sell something.

## For buyers

`pantry install` on a paid package you don't own stops with the price and what
to do about it:

```
my-package costs $9.00. Buy it with: pantry buy my-package
```

```bash
pantry buy my-package        # opens Stripe Checkout in your browser
pantry buy my-package --print # just print the URL (headless machines, CI)
pantry install my-package    # works once the payment lands
```

The purchase is recorded against your account, so the second machine only needs
your token:

```bash
pantry token set             # the same account's token
pantry install my-package
```

Buying from the web works too — every paid package's page has a Buy button.

## For registry operators

Payments need Stripe. On the public registry that's already configured; on
[your own registry](self-hosting.md):

```bash
pantry registry payments \
  --host registry.example.com \
  --secret-key sk_live_… \
  --webhook-secret whsec_…
```

Then add the webhook in Stripe:

| Setting | Value |
|---------|-------|
| Endpoint URL | `https://registry.example.com/webhooks/stripe` |
| Event | `checkout.session.completed` |

The signing secret is what makes a payment believable — the registry refuses any
webhook it can't verify, and rejects one more than five minutes old, so a
captured request can't be replayed into a free package. Without the secret
configured, no purchase would ever land.

`pantry registry payments --disable` turns payments off. Priced packages stay
priced and stay gated; nobody can complete a purchase until Stripe is configured
again.

### Payouts

Sales settle on the registry's own Stripe account by default — the operator is
the merchant of record and settles up with publishers however they choose.

When a publisher supplies a Stripe Connect account
(`pantry price set … --payout-account acct_…`), the charge is created with that
account as the transfer destination, so the money lands with them directly. The
platform's cut is configurable:

```bash
pantry registry payments --host … --secret-key … --webhook-secret … --fee-bps 1000  # 10%
```

Connect onboarding — creating those `acct_…` accounts and collecting the
publisher's tax and bank details — happens in your Stripe dashboard; the
registry only stores the id it's given.

## How it works

```
publisher                registry                     Stripe                buyer
    │                        │                           │                    │
    ├─ pantry price set ────▶│ (owner check, price)      │                    │
    │                        │                           │                    │
    │                        │◀───────────── pantry buy ──────────────────────┤
    │                        ├─ create Checkout session ─▶│                    │
    │                        │                           │◀─ pays ────────────┤
    │                        │◀─ checkout.session.completed (signed)          │
    │                        ├─ entitlement: user:<email>│                    │
    │                        │                           │                    │
    │                        │◀───────── GET tarball (Bearer token) ──────────┤
    │                        ├─ 200 ─────────────────────────────────────────▶│
```

The registry decides access in this order, and the first match wins:

1. no price on the package → **allow**
2. the version is in `--free-versions` → **allow**
3. the caller is the registry operator → **allow**
4. the caller published it → **allow**
5. the caller's account has an entitlement (and it hasn't expired) → **allow**
6. otherwise → **402 Payment Required**, with the price and a buy URL

## API

Everything the CLI does is a plain HTTP call, if you'd rather drive it yourself.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /packages/{name}/paywall` | optional | Price, and whether you own it |
| `POST /packages/{name}/paywall` | publisher | Set the price |
| `DELETE /packages/{name}/paywall` | publisher | Remove the price |
| `POST /packages/{name}/checkout` | buyer | Returns a Checkout URL |
| `GET /packages/{name}/buy` | session | Browser flow: sign in, then Stripe |
| `GET /publisher/api/packages/{name}/paywall` | session | Dashboard read |
| `PUT /publisher/api/packages/{name}/paywall` | session | Dashboard write |
| `POST /webhooks/stripe` | Stripe signature | Records the purchase |

```bash
curl -X POST https://registry.pantry.dev/packages/my-package/paywall \
  -H "Authorization: Bearer $PANTRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"price":900,"currency":"usd"}'
```

Prices are in the currency's smallest unit — `900` is $9.00. Zero-decimal
currencies (JPY) take whole units.

## Notes and limits

- **Refunds** are issued in Stripe. The entitlement is not revoked
  automatically; remove it with a registry operator's help if you need to.
- **Subscriptions** are not supported — a purchase is a one-time payment for
  ongoing access to the package.
- **Private registries** and paid packages compose: on a
  [private registry](self-hosting.md) everything already requires a credential,
  and a price adds "…and has paid" on top for that one package.
