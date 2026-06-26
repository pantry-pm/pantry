//! Native Mac App Store installs — no `mas`, no App Store GUI.
//!
//! Installs App Store apps the way the `mas` CLI does on current macOS, by
//! driving Apple's private StoreFoundation/CommerceKit frameworks through the
//! Objective-C runtime. The full flow (all validated against macOS 26):
//!
//!   1. Configure the shared `CKStoreClient` as `com.apple.AppStore`. Without
//!      this the CommerceKit TransactionService rejects a bare CLI ("nil
//!      storeClient.identifier") and silently does nothing; mas gets this client
//!      identity for free from its app-bundle identity.
//!   2. Build an `SSPurchase` for the adam id and hand it to
//!      `[CKPurchaseController sharedPurchaseController]`, which enqueues the same
//!      download `storedownloadd` performs for a Get/Install click. Two routes:
//!        • redownload — an app already in this Apple ID's purchase history
//!          (mas `install`: pricingParameters=STDRDL, isRedownload=YES).
//!        • acquire    — obtain a *free* app the account doesn't own yet
//!          (mas `get`: STDQ + macappinstalledconfirmed=1).
//!      We try redownload first, then acquire, so a never-obtained free app still
//!      installs without opening the App Store. A paid app the account doesn't
//!      own can't be bought head-less and just fails this step.
//!   3. Pump the main run loop (CommerceKit delivers on it) and poll
//!      `CKDownloadQueue` while hard-linking the downloaded installer `.pkg` (and
//!      its `_MASReceipt`) out of `CKDownloadDirectory` — storedownloadd deletes
//!      them ~1s after the download finishes, and a hard link keeps the inode.
//!   4. Run `/usr/sbin/installer -pkg <pkg> -target /` (via `sudo -n` unless
//!      already root) and drop the receipt into the installed bundle. The OS
//!      refuses to auto-install for a non-Apple-signed caller (PKInstallError
//!      201), so this manual step — and thus root — is required, exactly as in
//!      mas. Prime sudo before `pantry install` (or run it as root) so the
//!      `sudo -n` is non-interactive.
//!
//! Requirements at runtime: macOS, signed into the App Store, and root (or primed
//! sudo) for step 4. Every step is guarded: if a private class/selector is
//! missing (OS change), the purchase can't start, or the install can't run, we
//! return false so the caller can fall back to opening the App Store. The
//! Objective-C runtime and private frameworks are resolved with dlsym/dlopen at
//! runtime, so this needs no extra link-time dependency and still builds against
//! the public SDK.

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");

const id = ?*anyopaque;
const SEL = ?*anyopaque;
const Class = ?*anyopaque;

extern fn _NSGetExecutablePath(buf: [*]u8, bufsize: *u32) c_int;
extern fn dlopen(path: ?[*:0]const u8, mode: c_int) ?*anyopaque;
extern fn dlsym(handle: ?*anyopaque, symbol: [*:0]const u8) ?*anyopaque;
extern fn geteuid() u32;
extern fn link(oldpath: [*:0]const u8, newpath: [*:0]const u8) c_int;

// `CKDownloadDirectory(account)` — a plain C function (not a method) that returns
// the NSString path where storedownloadd stages an app's download. Resolved from
// CommerceKit at runtime; see `downloadDir`.
var ck_download_dir: ?*const fn (id) callconv(.c) id = null;

const RTLD_LAZY: c_int = 0x1;
const RTLD_DEFAULT: ?*anyopaque = @ptrFromInt(@as(usize, @bitCast(@as(isize, -2))));

const GetClassFn = *const fn ([*:0]const u8) callconv(.c) Class;
const SelFn = *const fn ([*:0]const u8) callconv(.c) SEL;

// CoreFoundation run-loop entry points. CommerceKit delivers its purchase
// completion on the main run loop, so we must *run* that loop rather than block
// the thread — a blocked thread would deadlock the callback. Resolved at runtime
// from CoreFoundation (loaded transitively by the private frameworks below).
const RunInModeFn = *const fn (mode: ?*anyopaque, seconds: f64, return_after_source: u8) callconv(.c) i32;
const GetRunLoopFn = *const fn () callconv(.c) ?*anyopaque;
const StopRunLoopFn = *const fn (?*anyopaque) callconv(.c) void;

// Objective-C runtime entry points, resolved once at runtime from libobjc
// (re-exported by libSystem). Kept as globals so the small message-send helpers
// below stay terse; `resolve()` must succeed before any are used.
var objc_getClass: GetClassFn = undefined;
var sel_registerName: SelFn = undefined;
var objc_msgSend: *const anyopaque = undefined;
var ns_global_block: *const anyopaque = undefined;
var cf_run_in_mode: RunInModeFn = undefined;
var cf_get_current: GetRunLoopFn = undefined;
var cf_stop: StopRunLoopFn = undefined;
var cf_default_mode: ?*anyopaque = undefined;

fn resolve() bool {
    objc_getClass = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "objc_getClass") orelse return false));
    sel_registerName = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "sel_registerName") orelse return false));
    objc_msgSend = dlsym(RTLD_DEFAULT, "objc_msgSend") orelse return false;
    ns_global_block = dlsym(RTLD_DEFAULT, "_NSConcreteGlobalBlock") orelse return false;
    // CoreFoundation is pulled in by StoreFoundation/CommerceKit; load it
    // explicitly too so these resolve even if framework load order changes.
    _ = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", RTLD_LAZY);
    cf_run_in_mode = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "CFRunLoopRunInMode") orelse return false));
    cf_get_current = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "CFRunLoopGetCurrent") orelse return false));
    cf_stop = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "CFRunLoopStop") orelse return false));
    // kCFRunLoopDefaultMode is an exported CFStringRef *variable* — dlsym yields
    // its address, so deref once to get the CFStringRef itself.
    const mode_ptr: *?*anyopaque = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "kCFRunLoopDefaultMode") orelse return false));
    cf_default_mode = mode_ptr.*;
    return true;
}

/// Cast objc_msgSend to a concrete signature for one call site.
fn msg(comptime Fn: type) Fn {
    return @ptrCast(@alignCast(objc_msgSend));
}

fn cls(name: [*:0]const u8) Class {
    return objc_getClass(name);
}

/// `[NSString stringWithUTF8String:str]`
fn nsString(str: [*:0]const u8) id {
    const f = msg(*const fn (Class, SEL, [*:0]const u8) callconv(.c) id);
    return f(cls("NSString"), sel_registerName("stringWithUTF8String:"), str);
}

/// `[NSNumber numberWithUnsignedLongLong:n]`
fn nsNumber(n: u64) id {
    const f = msg(*const fn (Class, SEL, u64) callconv(.c) id);
    return f(cls("NSNumber"), sel_registerName("numberWithUnsignedLongLong:"), n);
}

/// `[NSNumber numberWithBool:b]`
fn nsBool(b: bool) id {
    const f = msg(*const fn (Class, SEL, bool) callconv(.c) id);
    return f(cls("NSNumber"), sel_registerName("numberWithBool:"), b);
}

/// `[obj setValue:val forKey:key]` — KVC. Used instead of the typed setters so a
/// scalar property (e.g. the `unsigned long long itemIdentifier`) is set from an
/// NSNumber correctly: KVC unboxes it to the primitive. Calling `setItemIdentifier:`
/// directly with an NSNumber *pointer* would store garbage.
fn kvcSet(obj: id, key: [*:0]const u8, val: id) void {
    const f = msg(*const fn (id, SEL, id, id) callconv(.c) void);
    f(obj, sel_registerName("setValue:forKey:"), val, nsString(key));
}

/// `[nsstr UTF8String]` → C string (borrowed; valid while the NSString lives).
fn nsUTF8(s: id) ?[*:0]const u8 {
    if (s == null) return null;
    const f = msg(*const fn (id, SEL) callconv(.c) ?[*:0]const u8);
    return f(s, sel_registerName("UTF8String"));
}

/// `[obj sel]` returning an object.
fn call0(obj: id, sel_name: [*:0]const u8) id {
    const f = msg(*const fn (id, SEL) callconv(.c) id);
    return f(obj, sel_registerName(sel_name));
}

/// `[obj sel:arg]` returning an object.
fn call1(obj: id, sel_name: [*:0]const u8, arg: id) id {
    const f = msg(*const fn (id, SEL, id) callconv(.c) id);
    return f(obj, sel_registerName(sel_name), arg);
}

/// `[obj respondsToSelector:sel]` (works for both class and instance receivers).
fn responds(obj: id, sel_name: [*:0]const u8) bool {
    if (obj == null) return false;
    const f = msg(*const fn (id, SEL, SEL) callconv(.c) bool);
    return f(obj, sel_registerName("respondsToSelector:"), sel_registerName(sel_name));
}

/// Block layout matching the Objective-C ABI (Block_literal_1).
const Block = extern struct {
    isa: *const anyopaque,
    flags: c_int,
    reserved: c_int,
    invoke: *const anyopaque,
    descriptor: *const Descriptor,
    ok: *bool,
    done: *bool,
    runloop: ?*anyopaque,
};
const Descriptor = extern struct {
    reserved: c_ulong = 0,
    size: c_ulong = @sizeOf(Block),
};
var block_descriptor = Descriptor{};

// completionHandler(^)(SSPurchase*, BOOL completed, NSError*, SSPurchaseResponse*)
// Delivered on the main run loop; record the result and stop the loop so the
// waiter below returns immediately instead of running out its timeout.
fn purchaseDone(block: *Block, _: id, completed: bool, err: id, _: id) callconv(.c) void {
    block.ok.* = completed and err == null;
    block.done.* = true;
    if (block.runloop) |rl| cf_stop(rl);
}

/// Crash-isolated entry point used by callers. Re-invokes this same pantry
/// binary as `pantry __mas-install <adam_id>` so the actual Objective-C work
/// (which can raise an uncaught NSException on an OS change) runs in a
/// short-lived child. A child crash surfaces as a non-zero exit, which we treat
/// as "couldn't install" — it can never take down the parent `pantry install`.
pub fn installIsolated(allocator: std.mem.Allocator, adam_id: []const u8) bool {
    if (builtin.os.tag != .macos) return false;
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    var size: u32 = path_buf.len;
    if (_NSGetExecutablePath(&path_buf, &size) != 0) return false;
    const self = std.mem.sliceTo(&path_buf, 0);
    const res = io_helper.childRun(allocator, &[_][]const u8{ self, "__mas-install", adam_id }) catch return false;
    defer allocator.free(res.stdout);
    defer allocator.free(res.stderr);
    return switch (res.term) {
        .exited => |c| c == 0,
        else => false,
    };
}

fn dbg(comptime fmt: []const u8, args: anytype) void {
    if (io_helper.getenv("PANTRY_MAS_DEBUG") != null) std.debug.print("[mas] " ++ fmt ++ "\n", args);
}

/// Install the App Store app with the given numeric adam id (the `mas:` id).
/// Returns true once the app is actually installed into /Applications. The flow
/// mirrors the `mas` CLI on current macOS (see the file header): drive a silent
/// CommerceKit purchase, let storedownloadd download the app's installer package,
/// capture that package before storedownloadd cleans it up, then install it with
/// `/usr/sbin/installer`. Best-effort and fully guarded — prefer `installIsolated`
/// from normal code so a private-framework crash can't abort the surrounding
/// install.
pub fn install(adam_id: []const u8) bool {
    if (builtin.os.tag != .macos) return false;
    if (!resolve()) return false;

    const n = std.fmt.parseInt(u64, std.mem.trim(u8, adam_id, " \t\r\n"), 10) catch return false;

    // Load the private frameworks that vend SSPurchase / CKPurchaseController /
    // CKDownloadQueue, then resolve the CKDownloadDirectory C function from them.
    _ = dlopen("/System/Library/PrivateFrameworks/StoreFoundation.framework/StoreFoundation", RTLD_LAZY) orelse return false;
    _ = dlopen("/System/Library/PrivateFrameworks/CommerceKit.framework/CommerceKit", RTLD_LAZY) orelse return false;
    ck_download_dir = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "CKDownloadDirectory")));

    // CommerceKit's TransactionService refuses to vend a purchase controller to a
    // process whose store client has no identifier — a bare CLI has none, so it
    // logs "nil storeClient.identifier" and silently does nothing. Configure the
    // shared client as the App Store client first; this is what makes
    // `sharedPurchaseController` come back with a usable client (and is the step
    // mas gets "for free" from its app bundle identity).
    if (cls("CKStoreClient")) |StoreClient| {
        if (responds(StoreClient, "_configureSharedClientWithIdentifier:")) {
            _ = call1(StoreClient, "_configureSharedClientWithIdentifier:", nsString("com.apple.AppStore"));
        }
    }

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    // Redownload first (already-owned app), then acquire (free app the account
    // doesn't own yet). Both start the same silent storedownloadd download; the
    // second route is what lets a never-obtained free app install without
    // opening the App Store. See the file header for the parameter differences.
    if (attempt(allocator, n, .redownload)) return true;
    return attempt(allocator, n, .acquire);
}

const Route = enum { redownload, acquire };

/// Drive one purchase route end to end: enqueue the download, capture the
/// downloaded installer package, and install it. Returns true only once the app
/// is installed. Fully guarded — any missing private class/selector returns false
/// (the caller then tries the other route, or opens the App Store).
fn attempt(allocator: std.mem.Allocator, n: u64, route: Route) bool {
    const SSPurchase = cls("SSPurchase") orelse return false;
    const CKPurchaseController = cls("CKPurchaseController") orelse return false;
    const CKDownloadQueue = cls("CKDownloadQueue") orelse return false;

    // purchase = [[SSPurchase alloc] init]
    const purchase = call0(call0(SSPurchase, "alloc"), "init");
    if (purchase == null) return false;

    // Bail (rather than crash with an unrecognized-selector NSException) if this
    // macOS build doesn't expose the private API shape we drive. These selectors
    // have shifted across releases, so probe before sending.
    if (!responds(purchase, "setBuyParameters:") or !responds(purchase, "setValue:forKey:")) return false;

    // Buy parameters, matching mas: STDRDL re-downloads an owned app; STDQ +
    // macappinstalledconfirmed=1 acquires a free app the account doesn't own yet.
    var buf: [256]u8 = undefined;
    const params = switch (route) {
        .redownload => std.fmt.bufPrint(
            buf[0 .. buf.len - 1],
            "productType=C&price=0&pg=default&appExtVrsId=0&pricingParameters=STDRDL&salableAdamId={d}",
            .{n},
        ),
        .acquire => std.fmt.bufPrint(
            buf[0 .. buf.len - 1],
            "productType=C&price=0&pg=default&appExtVrsId=0&pricingParameters=STDQ&macappinstalledconfirmed=1&salableAdamId={d}",
            .{n},
        ),
    } catch return false;
    buf[params.len] = 0;
    const params_z: [*:0]const u8 = @ptrCast(buf[0..params.len :0].ptr);

    _ = call1(purchase, "setBuyParameters:", nsString(params_z));
    // Scalar/boolean fields go through KVC so NSNumbers are unboxed correctly.
    kvcSet(purchase, "itemIdentifier", nsNumber(n));
    kvcSet(purchase, "isRedownload", nsBool(route == .redownload));

    // Download metadata describing the item as a software download — mas sets
    // this on both paths; without it the queue may not stage the package.
    if (cls("SSDownloadMetadata")) |MetaCls| {
        const meta = call0(call0(MetaCls, "alloc"), "init");
        if (meta != null) {
            kvcSet(meta, "kind", nsString("software"));
            kvcSet(meta, "itemIdentifier", nsNumber(n));
            kvcSet(purchase, "downloadMetadata", meta);
        }
    }

    // controller = [CKPurchaseController sharedPurchaseController] (current
    // selector), with older spellings as fallbacks. Uses the shared client
    // configured in `install`.
    const controller = blk: {
        if (responds(CKPurchaseController, "sharedPurchaseController")) break :blk call0(CKPurchaseController, "sharedPurchaseController");
        if (responds(CKPurchaseController, "sharedController")) break :blk call0(CKPurchaseController, "sharedController");
        if (responds(CKPurchaseController, "alloc")) break :blk call0(call0(CKPurchaseController, "alloc"), "init");
        break :blk null;
    } orelse return false;
    if (!responds(controller, "performPurchase:withOptions:completionHandler:")) return false;

    const queue = call0(CKDownloadQueue, "sharedDownloadQueue");
    if (queue == null or !responds(queue, "downloadForItemIdentifier:")) return false;

    var ok = false;
    var purchase_done = false;
    var block = Block{
        .isa = ns_global_block,
        .flags = 0,
        .reserved = 0,
        .invoke = @ptrCast(&purchaseDone),
        .descriptor = &block_descriptor,
        .ok = &ok,
        .done = &purchase_done,
        .runloop = cf_get_current(),
    };

    // [controller performPurchase:purchase withOptions:0 completionHandler:block]
    const sel = sel_registerName("performPurchase:withOptions:completionHandler:") orelse return false;
    const perform = msg(*const fn (id, SEL, id, c_long, *Block) callconv(.c) void);
    perform(controller, sel, purchase, 0, &block);

    // Pump the run loop until CommerceKit accepts the purchase (the handler stops
    // the loop). If it errors or never accepts, give up on this route.
    var waited: f64 = 0;
    while (!purchase_done and waited < 30.0) {
        _ = cf_run_in_mode(cf_default_mode, 0.25, 0);
        waited += 0.25;
    }
    if (!ok) {
        dbg("route={s}: purchase not accepted", .{@tagName(route)});
        return false;
    }
    dbg("route={s}: purchase accepted, downloading", .{@tagName(route)});

    // storedownloadd now downloads the app's installer .pkg into
    // CKDownloadDirectory(nil)/<adamId>/ and removes it ~1s after finishing, so
    // we hard-link the .pkg (and its _MASReceipt) out as it appears — a hard link
    // is instant and keeps the inode alive after storedownloadd unlinks it.
    const base = downloadDir() orelse return false;
    const src_dir = std.fmt.allocPrint(allocator, "{s}/{d}", .{ base, n }) catch return false;
    const cap_dir = std.fmt.allocPrint(allocator, "{s}/.pantry-mas-{d}", .{ base, n }) catch return false;
    io_helper.makePath(cap_dir) catch {};
    defer io_helper.deleteTree(cap_dir) catch {};

    const cap_pkg = std.fmt.allocPrint(allocator, "{s}/app.pkg", .{cap_dir}) catch return false;
    const cap_receipt = std.fmt.allocPrint(allocator, "{s}/receipt", .{cap_dir}) catch return false;

    // Pump the run loop so the download progresses; capture as it goes. Stop once
    // the download leaves the queue (finished/failed) after having been present.
    var present = false;
    var dl_waited: f64 = 0;
    while (dl_waited < 900.0) {
        _ = cf_run_in_mode(cf_default_mode, 0.2, 0);
        dl_waited += 0.2;
        const dl = downloadForItem(queue, n);
        if (dl != null) {
            present = true;
            captureLatest(allocator, src_dir, ".pkg", cap_pkg);
            captureLatest(allocator, src_dir, "receipt", cap_receipt);
        } else if (present) {
            // One more capture pass in case files were still settling.
            captureLatest(allocator, src_dir, ".pkg", cap_pkg);
            captureLatest(allocator, src_dir, "receipt", cap_receipt);
            break;
        } else if (dl_waited > 60.0) {
            // The purchase was accepted but no download ever showed up — give up
            // on this route rather than spin the full timeout.
            break;
        }
    }

    // Did we capture a package? (Existence is enough; it's a complete xar by the
    // time the download leaves the queue.)
    io_helper.accessAbsolute(cap_pkg, .{}) catch {
        dbg("route={s}: no package captured", .{@tagName(route)});
        return false;
    };
    dbg("route={s}: captured package at {s}", .{ @tagName(route), cap_pkg });

    return installPackage(allocator, cap_pkg, cap_receipt);
}

/// CKDownloadDirectory(nil) as an owned slice, or null if unavailable.
fn downloadDir() ?[]const u8 {
    const f = ck_download_dir orelse return null;
    const ns = f(null);
    const c = nsUTF8(ns) orelse return null;
    return std.mem.sliceTo(c, 0);
}

/// `[queue downloadForItemIdentifier:n]` — the in-flight SSDownload, or nil.
fn downloadForItem(queue: id, n: u64) id {
    const f = msg(*const fn (id, SEL, u64) callconv(.c) id);
    return f(queue, sel_registerName("downloadForItemIdentifier:"), n);
}

/// Hard-link the newest file in `src_dir` whose name ends with `suffix` to
/// `dest` (replacing any previous capture atomically). Best-effort: silently does
/// nothing if the source is gone — the previously captured link stays valid
/// because a hard link keeps the inode alive after storedownloadd unlinks it.
fn captureLatest(allocator: std.mem.Allocator, src_dir: []const u8, suffix: []const u8, dest: []const u8) void {
    var dir = io_helper.openDirAbsoluteForIteration(src_dir) catch return;
    defer dir.close();
    var newest: ?[]u8 = null;
    defer if (newest) |nm| allocator.free(nm);
    var newest_mtime: i128 = std.math.minInt(i128);
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.name, suffix)) continue;
        const full = std.fmt.allocPrint(allocator, "{s}/{s}", .{ src_dir, entry.name }) catch continue;
        defer allocator.free(full);
        const st = io_helper.statFile(full) catch continue;
        if (st.mtime >= newest_mtime) {
            newest_mtime = st.mtime;
            if (newest) |old| allocator.free(old);
            newest = allocator.dupe(u8, entry.name) catch null;
        }
    }
    const name = newest orelse return;
    const src_buf = std.fmt.allocPrint(allocator, "{s}/{s}", .{ src_dir, name }) catch return;
    defer allocator.free(src_buf);
    const src = io_helper.dupeZ(allocator, u8, src_buf) catch return;
    defer allocator.free(src);
    const tmp_buf = std.fmt.allocPrint(allocator, "{s}.tmp", .{dest}) catch return;
    defer allocator.free(tmp_buf);
    const tmp = io_helper.dupeZ(allocator, u8, tmp_buf) catch return;
    defer allocator.free(tmp);
    io_helper.deleteFile(tmp) catch {};
    // Hard-link the source out (link(2)); the source may have just been cleaned
    // up by storedownloadd, in which case link fails and the prior capture stands.
    if (link(src.ptr, tmp.ptr) != 0) return;
    io_helper.rename(tmp, dest) catch {
        io_helper.deleteFile(tmp) catch {};
    };
}

/// Install a captured .pkg with `/usr/sbin/installer` (via sudo when not already
/// root), then drop the _MASReceipt into the installed bundle so the app reads as
/// App Store-provisioned. Returns true on a successful install.
fn installPackage(allocator: std.mem.Allocator, pkg: []const u8, receipt: []const u8) bool {
    const is_root = geteuid() == 0;
    const res = runCaptured(allocator, is_root, &[_][]const u8{ "/usr/sbin/installer", "-dumplog", "-pkg", pkg, "-target", "/" }) orelse return false;
    defer allocator.free(res.stdout);
    defer allocator.free(res.stderr);
    const installed = switch (res.term) {
        .exited => |c| c == 0,
        else => false,
    };
    if (!installed) {
        dbg("installer failed: {s}", .{res.stderr});
        return false;
    }

    // Place the receipt (best-effort). installer's -dumplog output names the
    // registered bundle as a file:// URL: "PackageKit: Registered bundle <url> for uid 0".
    if (appPathFromLog(res.stderr)) |app| {
        const masdir = std.fmt.allocPrint(allocator, "{s}/Contents/_MASReceipt", .{app}) catch return installed;
        defer allocator.free(masdir);
        const dest = std.fmt.allocPrint(allocator, "{s}/receipt", .{masdir}) catch return installed;
        defer allocator.free(dest);
        if (io_helper.accessAbsolute(receipt, .{})) |_| {
            _ = runPriv(allocator, is_root, &[_][]const u8{ "/bin/mkdir", "-p", masdir });
            _ = runPriv(allocator, is_root, &[_][]const u8{ "/bin/cp", receipt, dest });
        } else |_| {}
    }
    return installed;
}

/// Run `base_argv` (prefixed with `sudo -n` unless already root) and capture its
/// output, or null on spawn failure. Caller frees stdout/stderr. At most 6 base
/// args are supported (plus the 2-arg sudo prefix).
fn runCaptured(allocator: std.mem.Allocator, is_root: bool, base_argv: []const []const u8) ?io_helper.ChildRunResult {
    var argv_buf: [8][]const u8 = undefined;
    var len: usize = 0;
    if (!is_root) {
        argv_buf[0] = "sudo";
        argv_buf[1] = "-n";
        len = 2;
    }
    if (len + base_argv.len > argv_buf.len) return null;
    for (base_argv) |a| {
        argv_buf[len] = a;
        len += 1;
    }
    return io_helper.childRun(allocator, argv_buf[0..len]) catch null;
}

/// Run `base_argv`, prefixed with `sudo -n` unless already root. Returns true on
/// exit code 0.
fn runPriv(allocator: std.mem.Allocator, is_root: bool, base_argv: []const []const u8) bool {
    const res = runCaptured(allocator, is_root, base_argv) orelse return false;
    defer allocator.free(res.stdout);
    defer allocator.free(res.stderr);
    return switch (res.term) {
        .exited => |c| c == 0,
        else => false,
    };
}

/// Extract the installed bundle path from installer's -dumplog output, parsing
/// the `PackageKit: Registered bundle file:///… for uid 0` line. Returns a slice
/// into `log` (no allocation), or null.
fn appPathFromLog(log: []const u8) ?[]const u8 {
    const marker = "Registered bundle ";
    const start = std.mem.indexOf(u8, log, marker) orelse return null;
    var rest = log[start + marker.len ..];
    const end = std.mem.indexOf(u8, rest, " for uid") orelse return null;
    var url = rest[0..end];
    if (std.mem.startsWith(u8, url, "file://")) url = url["file://".len..];
    // Trim a trailing slash so callers can append "/Contents/...".
    if (std.mem.endsWith(u8, url, "/")) url = url[0 .. url.len - 1];
    if (url.len == 0 or url[0] != '/') return null;
    return url;
}
