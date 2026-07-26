# Paid packages

Publish a package, put a price on it, get paid. A buyer pays once, and the
purchase belongs to their **account** — every machine they sign in from can
install it, and rotating a token doesn't cost them what they bought.

The package's metadata stays public. That's deliberate: the page is where
someone reads what a package does and decides to buy it. What's gated is the
tarball.

## What selling costs

Publishing is free and installing is free. **Selling** a package costs a fee per
sale, paid to the registry — and a plan halves it, on top of unlocking the things
a serious publisher wants anyway.

List a package at $10 and sell one copy: **$1 goes to pantry on Free, or 50¢ on
a plan.** Nothing is charged until something sells.

| | Free | Pro — $9/mo | Team — $29/mo |
|---|---|---|---|
| Fee per sale | 10% | **5%** | **5%** |
| Private & unlisted packages | — | ✓ | ✓ |
| Analytics history | 30 days | full | full |
| Max artifact size | 50MB | 250MB | 1GB |
| Priority builds | — | ✓ | ✓ |
| Seats | 1 | 1 | 10 |

```bash
pantry plan             # what each plan costs and unlocks, from the registry
pantry subscribe pro    # subscribe in a browser
```

Three things worth being precise about:

- **The fee comes out of the sale, not on top of it.** A buyer pays exactly the
  price you listed; the fee is deducted from what reaches you.
- **A sale that started on pantry.dev adds 3%.** The registry put that package
  in front of someone who wasn't looking for it, so a site sale from a Pro
  seller is 5% + 3% = 8%. A sale you brought yourself — a link you sent, or
  `pantry buy` typed into a terminal — is just 5%.
- **Payment processing and sales tax are separate.** Card fees are Stripe's and
  settle against your own connected account (`on_behalf_of`), so the percentages
  above are what the registry charges you and nothing else.

Your plan is read at the moment of sale, not baked into the listing: subscribe
today and tomorrow's sales are commissioned at 5% without touching a single
package. A failed payment keeps your benefits while Stripe retries, and
cancelling keeps them until the period you already paid for runs out.

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

## Teams

The Team plan shares your packages with up to nine other accounts. A member can
publish new versions, price them, and manage them from the dashboard — and the
**seat holder's plan applies throughout**, so a member on a personal Free
account still gets the team's 1GB artifacts and 5% commission when they publish
to a team package.

```bash
pantry team add dev@yourco.com --session <session-token>
pantry team list
pantry team rm dev@yourco.com
```

Team changes need a signed-in session rather than an API token: sharing write
access to everything you've published is a decision a person makes, not
something a CI credential should be able to do.

Notes worth knowing:

- **An account is on one team.** Being on two would make "whose plan applies to
  this publish?" ambiguous on every upload.
- **Removing someone is immediate** — their next publish is refused. Packages
  they published under the account stay with the account.
- **Members need an account first.** Invite is by email, and the address has to
  already exist.

### Who may publish what

A package with a publisher only accepts new versions from that account, its
team, or the registry operator. A name nobody has published yet is still
first-come — publishing it claims it.

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
account as both the transfer destination and the settlement merchant
(`on_behalf_of`). The money lands with them directly, Stripe's processing fee
comes out of their side, and the registry takes its selling fee — 10% from a
free seller, 5% from a subscriber, plus 3% when the site made the sale.

Connect onboarding — creating those `acct_…` accounts and collecting the
publisher's tax and bank details — happens in your Stripe dashboard; the
registry only stores the id it's given.

### Subscription billing

Plans are ordinary Stripe subscriptions. The recurring prices are found or
created by `lookup_key` (`pantry_pro_monthly`, `pantry_team_monthly`) the first
time someone subscribes, so a fresh Stripe account sets itself up with nothing
to configure. Add these events to your webhook endpoint alongside
`checkout.session.completed`:

```
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

Stripe stays the source of truth: the registry mirrors what those events report
and never infers a plan from anything else, so a billing outage can't silently
upgrade or downgrade anyone.

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
| `POST /webhooks/stripe` | Stripe signature | Records purchases and plan changes |
| `GET /api/plans` | none | The tier table, prices and fees |
| `GET /account/subscription` | session | The account's current plan |
| `POST /account/subscription` | session | Start a plan checkout |
| `POST /account/billing-portal` | session | Change or cancel in Stripe |

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
- **Package purchases are one-time.** A purchase buys ongoing access to that
  package; recurring billing is for plans, not packages.
- **An API token can't move an account onto a paid plan.** Subscribing is
  something a person does about their own billing, so it needs a session.
- **Private registries** and paid packages compose: on a
  [private registry](self-hosting.md) everything already requires a credential,
  and a price adds "…and has paid" on top for that one package.
