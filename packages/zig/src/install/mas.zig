//! Native Mac App Store installs.
//!
//! Installs App Store apps the way the `mas` CLI does — by driving Apple's
//! private StoreFoundation/CommerceKit frameworks through the Objective-C
//! runtime — instead of shelling out to `mas` or bouncing the user into the
//! App Store GUI. We build an `SSPurchase` for the app's adam id and hand it to
//! `CKPurchaseController`, which kicks off the same download `storedownloadd`
//! performs for a Get/Install click.
//!
//! Requirements at runtime: macOS, signed into the App Store, and the app
//! present in that Apple ID's purchase history (Apple only allows installing
//! apps the account already "owns" — same constraint as `mas install`). Every
//! step is guarded: if a private class/selector is missing (OS change) or the
//! purchase can't be started, we return false so the caller can fall back to
//! opening the App Store. The Objective-C runtime and the private frameworks
//! are resolved with dlsym/dlopen at runtime, so this needs no extra link-time
//! dependency and still builds against the public SDK.

const std = @import("std");
const builtin = @import("builtin");
const io_helper = @import("../io_helper.zig");

const id = ?*anyopaque;
const SEL = ?*anyopaque;
const Class = ?*anyopaque;

extern fn _NSGetExecutablePath(buf: [*]u8, bufsize: *u32) c_int;
extern fn dlopen(path: ?[*:0]const u8, mode: c_int) ?*anyopaque;
extern fn dlsym(handle: ?*anyopaque, symbol: [*:0]const u8) ?*anyopaque;
extern fn dispatch_semaphore_create(value: isize) ?*anyopaque;
extern fn dispatch_semaphore_wait(sema: ?*anyopaque, timeout: u64) isize;
extern fn dispatch_semaphore_signal(sema: ?*anyopaque) isize;
extern fn dispatch_time(when: u64, delta: i64) u64;

const RTLD_LAZY: c_int = 0x1;
const DISPATCH_TIME_NOW: u64 = 0;
const RTLD_DEFAULT: ?*anyopaque = @ptrFromInt(@as(usize, @bitCast(@as(isize, -2))));

const GetClassFn = *const fn ([*:0]const u8) callconv(.c) Class;
const SelFn = *const fn ([*:0]const u8) callconv(.c) SEL;

// Objective-C runtime entry points, resolved once at runtime from libobjc
// (re-exported by libSystem). Kept as globals so the small message-send helpers
// below stay terse; `resolve()` must succeed before any are used.
var objc_getClass: GetClassFn = undefined;
var sel_registerName: SelFn = undefined;
var objc_msgSend: *const anyopaque = undefined;
var ns_global_block: *const anyopaque = undefined;

fn resolve() bool {
    objc_getClass = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "objc_getClass") orelse return false));
    sel_registerName = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "sel_registerName") orelse return false));
    objc_msgSend = dlsym(RTLD_DEFAULT, "objc_msgSend") orelse return false;
    ns_global_block = dlsym(RTLD_DEFAULT, "_NSConcreteGlobalBlock") orelse return false;
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
    sema: ?*anyopaque,
    ok: *bool,
};
const Descriptor = extern struct {
    reserved: c_ulong = 0,
    size: c_ulong = @sizeOf(Block),
};
var block_descriptor = Descriptor{};

// completionHandler(^)(SSPurchase*, BOOL completed, NSError*, SSPurchaseResponse*)
fn purchaseDone(block: *Block, _: id, completed: bool, err: id, _: id) callconv(.c) void {
    block.ok.* = completed and err == null;
    if (block.sema) |s| _ = dispatch_semaphore_signal(s);
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

/// Install the App Store app with the given numeric adam id (the `mas:` id).
/// Returns true once CommerceKit reports the purchase/download started
/// successfully. Best-effort and fully guarded — see the file header. Prefer
/// `installIsolated` from normal code so a private-framework crash can't abort
/// the surrounding install.
pub fn install(adam_id: []const u8) bool {
    if (builtin.os.tag != .macos) return false;
    if (!resolve()) return false;

    const n = std.fmt.parseInt(u64, std.mem.trim(u8, adam_id, " \t\r\n"), 10) catch return false;

    // Load the private frameworks that vend SSPurchase / CKPurchaseController.
    _ = dlopen("/System/Library/PrivateFrameworks/StoreFoundation.framework/StoreFoundation", RTLD_LAZY) orelse return false;
    _ = dlopen("/System/Library/PrivateFrameworks/CommerceKit.framework/CommerceKit", RTLD_LAZY) orelse return false;

    const SSPurchase = cls("SSPurchase") orelse return false;
    const CKPurchaseController = cls("CKPurchaseController") orelse return false;

    // purchase = [[SSPurchase alloc] init]
    const purchase = call0(call0(SSPurchase, "alloc"), "init");
    if (purchase == null) return false;

    // Bail (rather than crash with an unrecognized-selector NSException) if this
    // macOS build doesn't expose the private API shape we drive. These selectors
    // have shifted across releases, so probe before sending.
    if (!responds(purchase, "setBuyParameters:") or !responds(purchase, "setItemIdentifier:")) return false;

    // Buy parameters for installing an already-owned app (mas's "STDRDL").
    var buf: [192]u8 = undefined;
    const params = std.fmt.bufPrint(
        buf[0 .. buf.len - 1],
        "productType=C&price=0&salableAdamId={d}&pricingParameters=STDRDL&pg=default&appExtVrsId=0",
        .{n},
    ) catch return false;
    buf[params.len] = 0;
    const params_z: [*:0]const u8 = @ptrCast(buf[0..params.len :0].ptr);

    _ = call1(purchase, "setBuyParameters:", nsString(params_z));
    _ = call1(purchase, "setItemIdentifier:", nsNumber(n));
    // isRedownload = YES (installing something already owned)
    if (responds(purchase, "setIsRedownload:")) {
        const f = msg(*const fn (id, SEL, bool) callconv(.c) void);
        f(purchase, sel_registerName("setIsRedownload:"), true);
    }

    // controller = [CKPurchaseController sharedController], or a fresh instance
    // on builds that don't vend the singleton. Guarded so an OS that renamed
    // these returns false (→ caller opens the App Store) instead of crashing.
    const controller = blk: {
        if (responds(CKPurchaseController, "sharedController")) break :blk call0(CKPurchaseController, "sharedController");
        if (responds(CKPurchaseController, "alloc")) break :blk call0(call0(CKPurchaseController, "alloc"), "init");
        break :blk null;
    } orelse return false;
    if (!responds(controller, "performPurchase:withOptions:completionHandler:")) return false;

    const sema = dispatch_semaphore_create(0);
    var ok = false;
    var block = Block{
        .isa = ns_global_block,
        .flags = 0,
        .reserved = 0,
        .invoke = @ptrCast(&purchaseDone),
        .descriptor = &block_descriptor,
        .sema = sema,
        .ok = &ok,
    };

    // [controller performPurchase:purchase withOptions:0 completionHandler:block]
    const sel = sel_registerName("performPurchase:withOptions:completionHandler:") orelse return false;
    // withOptions: is an NSInteger (64-bit), so pass a c_long, not a c_int.
    const perform = msg(*const fn (id, SEL, id, c_long, *Block) callconv(.c) void);
    perform(controller, sel, purchase, 0, &block);

    // Wait up to 60s for CommerceKit to accept (and start) the download.
    const timeout = dispatch_time(DISPATCH_TIME_NOW, 60 * std.time.ns_per_s);
    if (dispatch_semaphore_wait(sema, timeout) != 0) return false; // timed out
    return ok;
}
