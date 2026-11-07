//! Best-effort download telemetry. Batches own their payloads independently of
//! installers; the host must call shutdown before destroying its I/O backend.
const std = @import("std");
const io_helper = @import("../io_helper.zig");

const Event = struct {
    packageName: []const u8,
    category: []const u8 = "download",
    version: []const u8,
};

const Batch = struct {
    allocator: std.mem.Allocator,
    events: std.ArrayList(Event),

    fn deinit(self: *Batch) void {
        for (self.events.items) |event| {
            self.allocator.free(event.packageName);
            self.allocator.free(event.version);
        }
        self.events.deinit(self.allocator);
        self.* = undefined;
    }

    fn sendUsing(self: *const Batch, comptime receiver: anytype, args: anytype) !void {
        const json = try std.json.Stringify.valueAlloc(self.allocator, self.events.items, .{});
        defer self.allocator.free(json);
        try @call(.auto, receiver, .{ self.allocator, json } ++ args);
    }
};

const Queue = struct {
    allocator: std.mem.Allocator,
    events: std.ArrayList(Event) = .empty,

    fn append(self: *Queue, domain: []const u8, version: []const u8) !void {
        const name = try self.allocator.dupe(u8, domain);
        errdefer self.allocator.free(name);
        const owned_version = try self.allocator.dupe(u8, version);
        errdefer self.allocator.free(owned_version);
        try self.events.append(self.allocator, .{ .packageName = name, .version = owned_version });
    }

    fn take(self: *Queue) Batch {
        const batch: Batch = .{ .allocator = self.allocator, .events = self.events };
        self.events = .empty;
        return batch;
    }
};

const Sender = struct {
    queue: Queue,
    mutex: std.Io.Mutex = .init,
    stopped: std.Io.Condition = .init,
    state: enum { running, stopping, stopped } = .running,
    group: std.Io.Group = .init,

    fn record(self: *Sender, io: std.Io, domain: []const u8, version: []const u8) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (self.state != .running) return;
        self.queue.append(domain, version) catch {};
    }

    fn flushUsing(self: *Sender, io: std.Io, comptime receiver: anytype, args: anytype) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (self.state != .running or self.queue.events.items.len == 0) return;
        var batch = self.queue.take();
        // Registration and admission are serialized. Workers own only their
        // batches and never need the sender lock, including during cleanup.
        const Worker = struct {
            fn run(owned: Batch, receiver_args: @TypeOf(args)) std.Io.Cancelable!void {
                var pending = owned;
                defer pending.deinit();
                pending.sendUsing(receiver, receiver_args) catch {};
            }
        };
        self.group.concurrent(io, Worker.run, .{ batch, args }) catch batch.deinit();
    }

    fn shutdown(self: *Sender, io: std.Io) void {
        self.mutex.lockUncancelable(io);
        while (self.state == .stopping) self.stopped.waitUncancelable(io, &self.mutex);
        if (self.state == .stopped) {
            self.mutex.unlock(io);
            return;
        }
        self.state = .stopping;
        var pending = self.queue.take();
        self.mutex.unlock(io);

        // No sender/queue lock is held while joining worker cleanup. Other
        // callers observe closed admission; only this caller cancels the group.
        self.group.cancel(io);
        pending.deinit();

        self.mutex.lockUncancelable(io);
        self.state = .stopped;
        self.stopped.broadcast(io);
        self.mutex.unlock(io);
    }
};

// This queue can outlive any individual installer's allocator. Each copied
// event, array, serialized body and HTTP response still has explicit cleanup.
var sender: Sender = .{ .queue = .{ .allocator = std.heap.page_allocator } };

pub fn record(domain: []const u8, version: []const u8) void {
    sender.record(io_helper.getIo(), domain, version);
}

fn post(allocator: std.mem.Allocator, body: []const u8) !void {
    const response = try io_helper.httpPostJson(allocator, "https://registry.pantry.dev/analytics/events", body);
    defer allocator.free(response);
}

pub fn flush() void {
    sender.flushUsing(io_helper.getIo(), post, .{});
}

pub fn shutdown() void {
    sender.shutdown(io_helper.getIo());
}

test "native analytics: a batch owns escaped event values after its producer is destroyed" {
    const allocator = std.testing.allocator;
    var queue: Queue = .{ .allocator = allocator };
    var producer = std.heap.ArenaAllocator.init(allocator);
    var producer_alive = true;
    defer if (producer_alive) producer.deinit();
    const domain = try producer.allocator().dupe(u8, "package\"\\\n.test");
    const version = try producer.allocator().dupe(u8, "1.0.0-\"\\\n");
    try queue.append(domain, version);
    var batch = queue.take();
    defer batch.deinit();
    producer.deinit();
    producer_alive = false;
    var empty = queue.take();
    defer empty.deinit();
    try std.testing.expectEqual(@as(usize, 0), empty.events.items.len);
    const Receiver = struct {
        fn receive(_: std.mem.Allocator, body: []const u8) !void {
            const parsed = try std.json.parseFromSlice([]Event, std.testing.allocator, body, .{});
            defer parsed.deinit();
            try std.testing.expectEqual(@as(usize, 1), parsed.value.len);
            try std.testing.expectEqualStrings("package\"\\\n.test", parsed.value[0].packageName);
            try std.testing.expectEqualStrings("download", parsed.value[0].category);
            try std.testing.expectEqualStrings("1.0.0-\"\\\n", parsed.value[0].version);
        }
    };
    try batch.sendUsing(Receiver.receive, .{});
}

test "native analytics: shutdown cancels and joins admitted work before returning and closes admission" {
    const io = std.testing.io;
    var local: Sender = .{ .queue = .{ .allocator = std.testing.allocator } };
    defer local.shutdown(io);
    const Receiver = struct {
        started: std.Io.Event = .unset,
        finished: std.atomic.Value(bool) = .init(false),
        canceled: std.atomic.Value(bool) = .init(false),
        valid: std.atomic.Value(bool) = .init(false),

        fn receive(_: std.mem.Allocator, body: []const u8, self: *@This()) !void {
            defer self.finished.store(true, .release);
            errdefer self.started.set(std.testing.io);
            const parsed = try std.json.parseFromSlice([]Event, std.testing.allocator, body, .{});
            defer parsed.deinit();
            try std.testing.expectEqual(@as(usize, 1), parsed.value.len);
            try std.testing.expectEqualStrings("first.test", parsed.value[0].packageName);
            self.valid.store(true, .release);
            self.started.set(std.testing.io);
            std.testing.io.sleep(.{ .nanoseconds = std.time.ns_per_s * 60 }, .awake) catch |err| {
                self.canceled.store(true, .release);
                return err;
            };
            return error.WorkWasNotCanceled;
        }
    };
    var receiver: Receiver = .{};
    local.record(io, "first.test", "1.0.0");
    local.flushUsing(io, Receiver.receive, .{&receiver});
    try receiver.started.wait(io);
    try std.testing.expect(receiver.valid.load(.acquire));
    local.record(io, "pending.test", "2.0.0");
    local.shutdown(io);
    try std.testing.expect(receiver.finished.load(.acquire));
    try std.testing.expect(receiver.canceled.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), local.queue.events.items.len);
    local.record(io, "closed.test", "3.0.0");
    local.flushUsing(io, Receiver.receive, .{&receiver});
    try std.testing.expectEqual(@as(usize, 0), local.queue.events.items.len);
    local.shutdown(io);
}
