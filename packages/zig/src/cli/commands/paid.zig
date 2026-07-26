//! Paid packages — charging for what you publish, and buying what someone else
//! published.
//!
//!   pantry price set <package> 9.00   Charge for a package you published
//!   pantry price show <package>       What it costs, and whether you own it
//!   pantry price rm <package>         Give it away again
//!   pantry buy <package>              Purchase access
//!
//! All four are HTTPS calls to the registry named by `--registry`, else
//! `PANTRY_REGISTRY_URL`, else the public registry — authenticated with the
//! credential `pantry token set` stores for it. Pricing is refused for anyone
//! but the account that published the package; the registry enforces that, and
//! these commands surface what it says.
//!
//! A purchase is recorded against your **account**, so it survives rotating a
//! token and works on every machine you sign in from.

const std = @import("std");
const io_helper = @import("../../io_helper.zig");
const style = @import("../style.zig");
const common = @import("common.zig");
const registry_ops = @import("registry_ops.zig");
const endpoint = @import("../../registry/endpoint.zig");

const CommandResult = common.CommandResult;

/// The registry these commands act on: an explicit flag, then whatever the
/// install path is already pointed at (`PANTRY_REGISTRY_URL`, else the public
/// registry) — so `pantry buy` and `pantry install` can never disagree about
/// which registry a package comes from.
fn registryUrl(arena: std.mem.Allocator, explicit: ?[]const u8) []const u8 {
    if (registry_ops.resolveRegistryUrl(arena, explicit)) |url| return url;
    return endpoint.baseUrl();
}

fn packageUrl(arena: std.mem.Allocator, base: []const u8, package: []const u8, suffix: []const u8) ![]const u8 {
    return std.fmt.allocPrint(arena, "{s}/packages/{s}{s}", .{ base, package, suffix });
}

fn authHeaders(arena: std.mem.Allocator, token: []const u8) ![]const std.http.Header {
    const value = try std.fmt.allocPrint(arena, "Bearer {s}", .{token});
    const headers = try arena.alloc(std.http.Header, 1);
    headers[0] = .{ .name = "Authorization", .value = value };
    return headers;
}

fn signInMessage(arena: std.mem.Allocator, url: []const u8) []const u8 {
    return std.fmt.allocPrint(arena,
        \\Error: no credential for {s}.
        \\
        \\Create an account at {s}/signup, then store a token:
        \\
        \\  pantry token set --registry {s}
    , .{ url, url, url }) catch "Error: no credential for this registry.";
}

// ---------------------------------------------------------------------------
// pantry price set / show / rm
// ---------------------------------------------------------------------------

pub const PriceOptions = struct {
    registry: ?[]const u8 = null,
    token: ?[]const u8 = null,
    package: []const u8,
    /// A human amount: "9", "9.00", "$9.00".
    amount: ?[]const u8 = null,
    currency: ?[]const u8 = null,
    /// Versions that stay free — repeatable as a comma-separated list.
    free_versions: ?[]const u8 = null,
    /// Stripe Connect account to be paid out to (`acct_…`).
    payout_account: ?[]const u8 = null,
};

/// Parse "9", "9.00" or "$9.00" into cents. Rejects anything else rather than
/// guessing — a mis-parsed price is a real-money mistake.
pub fn parsePriceToCents(input: []const u8, currency: []const u8) ?u64 {
    var cleaned: [64]u8 = undefined;
    var len: usize = 0;
    var seen_digit = false;
    for (std.mem.trim(u8, input, &std.ascii.whitespace)) |c| {
        if (c == ',') continue;
        if (c == '$' or c == '£' or c == ' ') {
            if (seen_digit) return null; // "9$" is not a price
            continue;
        }
        if (!std.ascii.isDigit(c) and c != '.') return null;
        if (std.ascii.isDigit(c)) seen_digit = true;
        if (len == cleaned.len) return null;
        cleaned[len] = c;
        len += 1;
    }
    if (!seen_digit) return null;

    const text = cleaned[0..len];
    const zero_decimal = std.ascii.eqlIgnoreCase(currency, "jpy");

    const dot = std.mem.indexOfScalar(u8, text, '.');
    if (dot == null) {
        const whole = std.fmt.parseInt(u64, text, 10) catch return null;
        return if (zero_decimal) whole else whole * 100;
    }

    const whole_part = text[0..dot.?];
    const frac_part = text[dot.? + 1 ..];
    if (frac_part.len == 0 or frac_part.len > 2) return null;
    if (std.mem.indexOfScalar(u8, frac_part, '.') != null) return null;
    if (zero_decimal) return null; // no fractional yen

    const whole = if (whole_part.len == 0) 0 else std.fmt.parseInt(u64, whole_part, 10) catch return null;
    const frac = std.fmt.parseInt(u64, frac_part, 10) catch return null;
    const cents = if (frac_part.len == 1) frac * 10 else frac;
    return whole * 100 + cents;
}

pub fn priceSetCommand(allocator: std.mem.Allocator, opts: PriceOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const token = registry_ops.credentialFor(arena, opts.token, url) orelse
        return CommandResult.err(allocator, signInMessage(arena, url));

    const amount = opts.amount orelse
        return CommandResult.err(allocator, "Error: a price is required, e.g. `pantry price set my-package 9.00`.");
    const currency = opts.currency orelse "usd";
    const cents = parsePriceToCents(amount, currency) orelse
        return CommandResult.err(allocator, "Error: that price isn't a number of dollars and cents (try 9, 9.00 or $9.00).");

    var body: std.ArrayList(u8) = .empty;
    var cents_buf: [64]u8 = undefined;
    try body.appendSlice(arena, try std.fmt.bufPrint(&cents_buf, "{{\"price\":{d}", .{cents}));
    try body.appendSlice(arena, ",\"currency\":");
    try registry_ops.appendJsonString(&body, arena, currency);
    if (opts.free_versions) |list| {
        try body.appendSlice(arena, ",\"freeVersions\":[");
        var it = std.mem.splitScalar(u8, list, ',');
        var first = true;
        while (it.next()) |raw| {
            const version = std.mem.trim(u8, raw, &std.ascii.whitespace);
            if (version.len == 0) continue;
            if (!first) try body.append(arena, ',');
            try registry_ops.appendJsonString(&body, arena, version);
            first = false;
        }
        try body.append(arena, ']');
    }
    if (opts.payout_account) |account| {
        try body.appendSlice(arena, ",\"payoutAccountId\":");
        try registry_ops.appendJsonString(&body, arena, account);
    }
    try body.append(arena, '}');

    const target = try packageUrl(arena, url, opts.package, "/paywall");
    const res = io_helper.httpRequest(arena, .POST, target, body.items, try authHeaders(arena, token)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));

    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not set the price: {s}", .{registry_ops.apiError(arena, res)}));

    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return CommandResult.success(allocator, "Price updated.");
    defer parsed.deinit();

    const paywall = if (parsed.value == .object) parsed.value.object.get("paywall") else null;
    const formatted = blk: {
        if (paywall) |p| {
            if (p == .object) {
                if (p.object.get("formattedPrice")) |f| {
                    if (f == .string) break :blk f.string;
                }
            }
        }
        break :blk amount;
    };
    const payments_on = blk: {
        if (paywall) |p| {
            if (p == .object) {
                if (p.object.get("paymentsEnabled")) |f| break :blk f == .bool and f.bool;
            }
        }
        break :blk true;
    };

    const message = try std.fmt.allocPrint(arena,
        \\{s} now costs {s}.
        \\
        \\Its metadata stays public — that is how people find it and decide to
        \\buy — but the tarball is refused until an account has paid.
        \\
        \\  Buyers:  pantry buy {s}
        \\  Page:    {s}/pkg/{s}
        \\{s}
    , .{
        opts.package,
        formatted,
        opts.package,
        url,
        opts.package,
        if (payments_on) "" else "\nNote: this registry has no Stripe key configured, so nobody can pay yet.\n",
    });

    return CommandResult.success(allocator, message);
}

pub fn priceShowCommand(allocator: std.mem.Allocator, opts: PriceOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const target = try packageUrl(arena, url, opts.package, "/paywall");

    // Authenticate when we can: the answer includes whether *you* own it.
    const headers: []const std.http.Header = if (registry_ops.credentialFor(arena, opts.token, url)) |token|
        try authHeaders(arena, token)
    else
        &.{};

    const res = io_helper.httpRequest(arena, .GET, target, null, headers) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));

    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not read the price: {s}", .{registry_ops.apiError(arena, res)}));

    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    defer parsed.deinit();

    const root = parsed.value;
    const enabled = if (root == .object) root.object.get("enabled") else null;
    if (enabled == null or enabled.? != .bool or !enabled.?.bool)
        return CommandResult.success(allocator, try std.fmt.allocPrint(arena, "{s} is free.", .{opts.package}));

    const formatted = blk: {
        if (root.object.get("formattedPrice")) |f| {
            if (f == .string) break :blk f.string;
        }
        break :blk "(unknown)";
    };
    const owned = blk: {
        if (root.object.get("owned")) |o| break :blk o == .bool and o.bool;
        break :blk false;
    };

    var free_note: []const u8 = "";
    if (root.object.get("freeVersions")) |fv| {
        if (fv == .array and fv.array.items.len > 0) {
            var list: std.ArrayList(u8) = .empty;
            try list.appendSlice(arena, "\n  Free versions: ");
            for (fv.array.items, 0..) |item, i| {
                if (item != .string) continue;
                if (i > 0) try list.appendSlice(arena, ", ");
                try list.appendSlice(arena, item.string);
            }
            free_note = list.items;
        }
    }

    const message = try std.fmt.allocPrint(arena, "{s}\n  Price: {s}\n  You:   {s}{s}", .{
        opts.package,
        formatted,
        if (owned) "own it — installs work" else "have not bought it yet",
        free_note,
    });
    return CommandResult.success(allocator, message);
}

pub fn priceRemoveCommand(allocator: std.mem.Allocator, opts: PriceOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const token = registry_ops.credentialFor(arena, opts.token, url) orelse
        return CommandResult.err(allocator, signInMessage(arena, url));

    const target = try packageUrl(arena, url, opts.package, "/paywall");
    const res = io_helper.httpRequest(arena, .DELETE, target, null, try authHeaders(arena, token)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));

    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not remove the price: {s}", .{registry_ops.apiError(arena, res)}));

    return CommandResult.success(allocator, try std.fmt.allocPrint(arena, "{s} is free again. Existing purchases keep working.", .{opts.package}));
}

// ---------------------------------------------------------------------------
// pantry buy
// ---------------------------------------------------------------------------

pub const BuyOptions = struct {
    registry: ?[]const u8 = null,
    token: ?[]const u8 = null,
    package: []const u8,
    /// Print the checkout URL instead of opening a browser.
    print_only: bool = false,
};

pub fn buyCommand(allocator: std.mem.Allocator, opts: BuyOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const token = registry_ops.credentialFor(arena, opts.token, url) orelse
        return CommandResult.err(allocator, signInMessage(arena, url));

    const target = try packageUrl(arena, url, opts.package, "/checkout");
    const res = io_helper.httpRequest(arena, .POST, target, "{}", try authHeaders(arena, token)) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));

    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not start checkout: {s}", .{registry_ops.apiError(arena, res)}));

    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    defer parsed.deinit();

    if (parsed.value == .object) {
        if (parsed.value.object.get("owned")) |owned| {
            if (owned == .bool and owned.bool)
                return CommandResult.success(allocator, try std.fmt.allocPrint(arena, "You already own {s} — `pantry install {s}` will work.", .{ opts.package, opts.package }));
        }
    }

    const checkout = blk: {
        if (parsed.value == .object) {
            if (parsed.value.object.get("url")) |u| {
                if (u == .string) break :blk u.string;
            }
        }
        return CommandResult.err(allocator, "The registry did not return a checkout URL.");
    };

    // Payment happens in a browser — Stripe Checkout is a hosted page, and
    // taking card details in a terminal is not something we're going to do.
    var opened = false;
    if (!opts.print_only) opened = openInBrowser(arena, checkout);

    const message = try std.fmt.allocPrint(arena,
        \\{s}
        \\
        \\  {s}
        \\
        \\Once the payment goes through, the purchase is recorded against your
        \\account — every machine you're signed in on can install it:
        \\
        \\  pantry install {s}
    , .{
        if (opened) "Opened checkout in your browser:" else "Complete the purchase here:",
        checkout,
        opts.package,
    });

    return CommandResult.success(allocator, message);
}

fn openInBrowser(arena: std.mem.Allocator, url: []const u8) bool {
    const argv: []const []const u8 = switch (@import("builtin").os.tag) {
        .macos => &.{ "open", url },
        .windows => &.{ "cmd", "/c", "start", url },
        else => &.{ "xdg-open", url },
    };
    const result = io_helper.childRun(arena, argv) catch return false;
    return switch (result.term) {
        .exited => |code| code == 0,
        else => false,
    };
}

// ---------------------------------------------------------------------------
// pantry subscribe / pantry plan
// ---------------------------------------------------------------------------

pub const PlanOptions = struct {
    registry: ?[]const u8 = null,
    token: ?[]const u8 = null,
    /// "pro" or "team".
    tier: ?[]const u8 = null,
    print_only: bool = false,
};

/// What the plans cost and what they change, straight from the registry — so
/// the CLI never disagrees with the pricing page.
pub fn plansCommand(allocator: std.mem.Allocator, opts: PlanOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const target = try std.fmt.allocPrint(arena, "{s}/api/plans", .{url});
    const res = io_helper.httpRequest(arena, .GET, target, null, &.{}) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));

    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not read the plans: {s}", .{registry_ops.apiError(arena, res)}));

    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return CommandResult.err(allocator, "The registry returned a response this version doesn't understand.");
    defer parsed.deinit();

    var out: std.ArrayList(u8) = .empty;
    const plans = if (parsed.value == .object) parsed.value.object.get("plans") else null;
    if (plans == null or plans.? != .array)
        return CommandResult.err(allocator, "That registry does not offer subscriptions.");

    for (plans.?.array.items) |plan| {
        if (plan != .object) continue;
        const name = jsonString(plan, "name") orelse continue;
        const price = jsonString(plan, "formattedPrice") orelse "";
        // Newer registries send `sellingFee`; `commission` is the old alias.
        const selling_fee = jsonString(plan, "sellingFee") orelse jsonString(plan, "commission") orelse "";
        const mb = if (plan.object.get("maxArtifactMB")) |v| (if (v == .integer) v.integer else 0) else 0;
        const private = jsonBool(plan, "privatePackages");
        const priority = jsonBool(plan, "priorityBuilds");
        const days = if (plan.object.get("analyticsRetentionDays")) |v| (if (v == .integer) v.integer else 0) else 0;
        const seats = if (plan.object.get("seats")) |v| (if (v == .integer) v.integer else 1) else 1;

        var line: [512]u8 = undefined;
        const rendered = try std.fmt.bufPrint(&line,
            \\{s} — {s}
            \\  Fee per sale:        {s}
            \\  Private packages:    {s}
            \\  Analytics history:   {s}
            \\  Max artifact:        {d}MB
            \\  Priority builds:     {s}
            \\  Seats:               {d}
            \\
            \\
        , .{
            name,
            price,
            selling_fee,
            if (private) "yes" else "no",
            if (days >= 3650) "full" else "30 days",
            mb,
            if (priority) "yes" else "no",
            seats,
        });
        try out.appendSlice(arena, rendered);
    }

    if (jsonString(parsed.value, "discoveryFee")) |fee| {
        try out.appendSlice(arena, try std.fmt.allocPrint(arena,
            "A sale that started on the registry's website adds a {s} discovery fee.\n" ++
                "Sales you bring yourself (a link you sent, `pantry buy`) do not.\n", .{fee}));
    }

    return CommandResult.success(allocator, out.items);
}

fn jsonString(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    const found = value.object.get(key) orelse return null;
    return if (found == .string) found.string else null;
}

fn jsonBool(value: std.json.Value, key: []const u8) bool {
    if (value != .object) return false;
    const found = value.object.get(key) orelse return false;
    return found == .bool and found.bool;
}

/// Subscriptions are billed to a person, so this hands off to a browser session
/// rather than accepting a token: an API token deliberately cannot move an
/// account onto a paid plan.
pub fn subscribeCommand(allocator: std.mem.Allocator, opts: PlanOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const tier = opts.tier orelse "pro";
    if (!std.mem.eql(u8, tier, "pro") and !std.mem.eql(u8, tier, "team"))
        return CommandResult.err(allocator, "Error: the plan must be `pro` or `team` (see `pantry plan`).");

    const target = try std.fmt.allocPrint(arena, "{s}/pricing?plan={s}", .{ url, tier });

    var opened = false;
    if (!opts.print_only) opened = openInBrowser(arena, target);

    const message = try std.fmt.allocPrint(arena,
        \\{s}
        \\
        \\  {s}
        \\
        \\Subscribing is billed to your account, so it happens in a browser
        \\where you're signed in. Once it's active:
        \\
        \\  pantry plan            what every plan costs and unlocks
        \\  pantry price set …     your sales are now commissioned at the lower rate
    , .{
        if (opened) "Opened the pricing page in your browser:" else "Subscribe here:",
        target,
    });

    return CommandResult.success(allocator, message);
}

// ---------------------------------------------------------------------------
// pantry team
// ---------------------------------------------------------------------------

pub const TeamOptions = struct {
    registry: ?[]const u8 = null,
    /// Session token. Team changes are billing-adjacent, so the registry wants
    /// a signed-in person rather than a machine token.
    session: ?[]const u8 = null,
    email: ?[]const u8 = null,
};

fn sessionHeaders(arena: std.mem.Allocator, session: []const u8) ![]const std.http.Header {
    const cookie = try std.fmt.allocPrint(arena, "pantry_session={s}", .{session});
    const headers = try arena.alloc(std.http.Header, 1);
    headers[0] = .{ .name = "Cookie", .value = cookie };
    return headers;
}

const team_session_help =
    \\Error: team changes need a signed-in session, not an API token.
    \\
    \\Sign in on the website and pass the session, or manage the team there:
    \\
    \\  pantry team list --session <token>
;

fn teamRequest(
    arena: std.mem.Allocator,
    method: std.http.Method,
    url: []const u8,
    path: []const u8,
    session: []const u8,
    body: ?[]const u8,
) !io_helper.HttpResponse {
    const target = try std.fmt.allocPrint(arena, "{s}{s}", .{ url, path });
    return io_helper.httpRequest(arena, method, target, body, try sessionHeaders(arena, session));
}

fn renderTeam(arena: std.mem.Allocator, res: io_helper.HttpResponse) ![]const u8 {
    var parsed = std.json.parseFromSlice(std.json.Value, arena, res.body, .{ .ignore_unknown_fields = true }) catch
        return "Team updated.";
    defer parsed.deinit();

    const root = parsed.value;
    const seats = if (root == .object) (if (root.object.get("seats")) |v| (if (v == .integer) v.integer else 1) else 1) else 1;
    const used = if (root == .object) (if (root.object.get("seatsUsed")) |v| (if (v == .integer) v.integer else 1) else 1) else 1;

    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, try std.fmt.allocPrint(arena, "Seats: {d} of {d} used\n", .{ used, seats }));

    if (root == .object) {
        if (root.object.get("memberOf")) |owner| {
            if (owner == .string) {
                try out.appendSlice(arena, try std.fmt.allocPrint(arena, "You are on {s}'s team.\n", .{owner.string}));
            }
        }
        if (root.object.get("members")) |members| {
            if (members == .array) {
                if (members.array.items.len == 0) {
                    try out.appendSlice(arena, "No members yet — add one with `pantry team add <email>`.\n");
                } else {
                    try out.appendSlice(arena, "Members:\n");
                    for (members.array.items) |m| {
                        if (m != .string) continue;
                        try out.appendSlice(arena, try std.fmt.allocPrint(arena, "  {s}\n", .{m.string}));
                    }
                }
            }
        }
    }

    return out.items;
}

pub fn teamListCommand(allocator: std.mem.Allocator, opts: TeamOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const session = opts.session orelse return CommandResult.err(allocator, team_session_help);

    const res = teamRequest(arena, .GET, url, "/account/team", session, null) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));
    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not read the team: {s}", .{registry_ops.apiError(arena, res)}));

    return CommandResult.success(allocator, try renderTeam(arena, res));
}

pub fn teamAddCommand(allocator: std.mem.Allocator, opts: TeamOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const session = opts.session orelse return CommandResult.err(allocator, team_session_help);
    const email = opts.email orelse return CommandResult.err(allocator, "Error: an email address is required (`pantry team add dev@yourco.com`).");

    var body: std.ArrayList(u8) = .empty;
    try body.appendSlice(arena, "{\"email\":");
    try registry_ops.appendJsonString(&body, arena, email);
    try body.append(arena, '}');

    const res = teamRequest(arena, .POST, url, "/account/team/members", session, body.items) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));
    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not add them: {s}", .{registry_ops.apiError(arena, res)}));

    const rendered = try renderTeam(arena, res);
    return CommandResult.success(allocator, try std.fmt.allocPrint(arena,
        "{s} can now publish to and manage your packages.\n\n{s}", .{ email, rendered }));
}

pub fn teamRemoveCommand(allocator: std.mem.Allocator, opts: TeamOptions) !CommandResult {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const url = registryUrl(arena, opts.registry);
    const session = opts.session orelse return CommandResult.err(allocator, team_session_help);
    const email = opts.email orelse return CommandResult.err(allocator, "Error: an email address is required (`pantry team rm dev@yourco.com`).");

    const path = try std.fmt.allocPrint(arena, "/account/team/members/{s}", .{email});
    const res = teamRequest(arena, .DELETE, url, path, session, null) catch
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not reach {s}.", .{url}));
    if (!res.ok())
        return CommandResult.err(allocator, try std.fmt.allocPrint(arena, "Could not remove them: {s}", .{registry_ops.apiError(arena, res)}));

    const rendered = try renderTeam(arena, res);
    return CommandResult.success(allocator, try std.fmt.allocPrint(arena,
        "{s} no longer has access. Packages they published under your account stay yours.\n\n{s}", .{ email, rendered }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "prices are parsed the way people write them" {
    try std.testing.expectEqual(@as(?u64, 900), parsePriceToCents("9", "usd"));
    try std.testing.expectEqual(@as(?u64, 900), parsePriceToCents("9.00", "usd"));
    try std.testing.expectEqual(@as(?u64, 1999), parsePriceToCents("$19.99", "usd"));
    try std.testing.expectEqual(@as(?u64, 1950), parsePriceToCents("19.5", "usd"));
    try std.testing.expectEqual(@as(?u64, 129950), parsePriceToCents("1,299.50", "usd"));
    try std.testing.expectEqual(@as(?u64, 50), parsePriceToCents("0.50", "usd"));
}

test "anything that isn't a price is refused rather than guessed at" {
    try std.testing.expect(parsePriceToCents("free", "usd") == null);
    try std.testing.expect(parsePriceToCents("9.999", "usd") == null);
    try std.testing.expect(parsePriceToCents("9.9.9", "usd") == null);
    try std.testing.expect(parsePriceToCents("", "usd") == null);
    try std.testing.expect(parsePriceToCents("-5", "usd") == null);
    try std.testing.expect(parsePriceToCents("9$", "usd") == null);
}

test "zero-decimal currencies take whole units" {
    try std.testing.expectEqual(@as(?u64, 500), parsePriceToCents("500", "jpy"));
    try std.testing.expect(parsePriceToCents("5.00", "jpy") == null);
}
