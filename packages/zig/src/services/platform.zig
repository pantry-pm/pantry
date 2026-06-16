const std = @import("std");
const builtin = @import("builtin");
const definitions = @import("definitions.zig");
const lib = @import("../lib.zig");
const io_helper = lib.io_helper;

/// Whether services are managed in the per-user systemd instance (`systemctl
/// --user`, units under `~/.config/systemd/user`, `WantedBy=default.target`) or
/// the system instance (`systemctl`, units under `/etc/systemd/system`,
/// `WantedBy=multi-user.target`).
///
/// User scope is right for an interactive dev machine. It is unusable on a
/// headless server: root in a cloud-init / SSH-command context has no user
/// systemd bus (`Failed to connect to bus`) and `--user` units never start at
/// boot without `loginctl enable-linger`. So default to **system** scope when
/// running as root, and let `PANTRY_SERVICE_SCOPE=user|system` force either.
pub const ServiceScope = enum {
    user,
    system,

    pub fn detect() ServiceScope {
        if (io_helper.getEnvVarOwned(std.heap.page_allocator, "PANTRY_SERVICE_SCOPE")) |raw| {
            defer std.heap.page_allocator.free(raw);
            if (std.mem.eql(u8, raw, "system")) return .system;
            if (std.mem.eql(u8, raw, "user")) return .user;
        } else |_| {}
        // No explicit override: root manages system services, everyone else
        // manages their own user services.
        return if (builtin.os.tag == .windows) .user else if (std.posix.geteuid() == 0) .system else .user;
    }
};

/// Platform-specific service management
pub const Platform = enum {
    macos,
    linux,
    windows,
    freebsd,
    unknown,

    pub fn detect() Platform {
        return switch (builtin.os.tag) {
            .macos => .macos,
            .linux => .linux,
            .windows => .windows,
            .freebsd => .freebsd,
            else => .unknown,
        };
    }

    pub fn serviceManager(self: Platform) []const u8 {
        return switch (self) {
            .macos => "launchd",
            .linux => "systemd",
            .windows => "sc",
            .freebsd => "rc.d",
            .unknown => "unsupported",
        };
    }

    pub fn serviceFileExtension(self: Platform) []const u8 {
        return switch (self) {
            .macos => ".plist",
            .linux => ".service",
            .windows => ".xml",
            .freebsd => "",
            .unknown => "",
        };
    }

    pub fn serviceDirectory(self: Platform, allocator: std.mem.Allocator) ![]const u8 {
        return switch (self) {
            .macos => try allocator.dupe(u8, "/Library/LaunchDaemons"),
            .linux => try allocator.dupe(u8, "/etc/systemd/system"),
            .windows => try allocator.dupe(u8, "C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming"),
            .freebsd => try allocator.dupe(u8, "/usr/local/etc/rc.d"),
            .unknown => error.UnsupportedPlatform,
        };
    }

    pub fn userServiceDirectory(self: Platform, allocator: std.mem.Allocator) ![]const u8 {
        const home = io_helper.getEnvVarOwned(allocator, "HOME") catch |err| {
            if (err == error.EnvironmentVariableNotFound) {
                // Try USERPROFILE on Windows
                return io_helper.getEnvVarOwned(allocator, "USERPROFILE") catch return error.HomeNotFound;
            }
            return error.HomeNotFound;
        };
        defer allocator.free(home);

        return switch (self) {
            .macos => try std.fmt.allocPrint(allocator, "{s}/Library/LaunchAgents", .{home}),
            .linux => try std.fmt.allocPrint(allocator, "{s}/.config/systemd/user", .{home}),
            .freebsd => try std.fmt.allocPrint(allocator, "{s}/.config/pantry/services", .{home}),
            .windows => error.UnsupportedPlatform,
            .unknown => error.UnsupportedPlatform,
        };
    }
};

/// Platform-specific service controller
pub const ServiceController = struct {
    platform: Platform,
    scope: ServiceScope,
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) ServiceController {
        return .{
            .platform = Platform.detect(),
            .scope = ServiceScope.detect(),
            .allocator = allocator,
        };
    }

    /// Start a service (load and start)
    pub fn start(self: *ServiceController, service_name: []const u8) !void {
        switch (self.platform) {
            .macos => try self.launchdStart(service_name),
            .linux => try self.systemdStart(service_name),
            .freebsd => try self.rcdStart(service_name),
            .windows => return error.UnsupportedPlatform,
            .unknown => return error.UnsupportedPlatform,
        }
    }

    /// Enable a service (auto-start on boot)
    pub fn enable(self: *ServiceController, service_name: []const u8) !void {
        switch (self.platform) {
            .macos => {}, // launchd handles this via RunAtLoad in plist
            .linux => try self.systemdEnable(service_name),
            .freebsd => try self.rcdEnable(service_name),
            .windows => return error.UnsupportedPlatform,
            .unknown => return error.UnsupportedPlatform,
        }
    }

    /// Disable a service (don't auto-start on boot)
    pub fn disable(self: *ServiceController, service_name: []const u8) !void {
        switch (self.platform) {
            .macos => {}, // launchd handles this via plist modification
            .linux => try self.systemdDisable(service_name),
            .freebsd => try self.rcdDisable(service_name),
            .windows => return error.UnsupportedPlatform,
            .unknown => return error.UnsupportedPlatform,
        }
    }

    /// Stop a service
    pub fn stop(self: *ServiceController, service_name: []const u8) !void {
        switch (self.platform) {
            .macos => try self.launchdStop(service_name),
            .linux => try self.systemdStop(service_name),
            .freebsd => try self.rcdStop(service_name),
            .windows => return error.UnsupportedPlatform,
            .unknown => return error.UnsupportedPlatform,
        }
    }

    /// Restart a service
    pub fn restart(self: *ServiceController, service_name: []const u8) !void {
        try self.stop(service_name);
        // Small delay to ensure service fully stops (500ms)
        const delay_ns: u64 = std.time.ns_per_s / 2;
        io_helper.nanosleep(delay_ns / std.time.ns_per_s, delay_ns % std.time.ns_per_s);
        try self.start(service_name);
    }

    /// Get service status
    pub fn status(self: *ServiceController, service_name: []const u8) !definitions.ServiceStatus {
        return switch (self.platform) {
            .macos => try self.launchdStatus(service_name),
            .linux => try self.systemdStatus(service_name),
            .freebsd => try self.rcdStatus(service_name),
            .windows => error.UnsupportedPlatform,
            .unknown => error.UnsupportedPlatform,
        };
    }

    /// Check if service is running
    pub fn isRunning(self: *ServiceController, service_name: []const u8) !bool {
        const st = try self.status(service_name);
        return st == .running;
    }

    // ========================================================================
    // macOS launchd implementation
    // ========================================================================

    fn launchdStart(self: *ServiceController, service_name: []const u8) !void {
        const service_file = try self.getLaunchdServiceFile(service_name);
        defer self.allocator.free(service_file);

        // Capture launchctl's stdio rather than inheriting it. If inherited, its
        // messages ("Load failed: ...") land on the parent's stdout — which, for
        // `eval "$(pantry env)"`, is captured and corrupts the shell code.
        const argv = [_][]const u8{ "launchctl", "load", service_file };
        const result = io_helper.childRun(self.allocator, &argv) catch return error.ServiceStartFailed;
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        const ok = switch (result.term) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!ok) return error.ServiceStartFailed;
    }

    fn launchdStop(self: *ServiceController, service_name: []const u8) !void {
        const service_file = try self.getLaunchdServiceFile(service_name);
        defer self.allocator.free(service_file);

        // Capture launchctl's stdio (see launchdStart) so it can't contaminate
        // a captured stdout such as `eval "$(pantry env)"`.
        const argv = [_][]const u8{ "launchctl", "unload", service_file };
        const result = io_helper.childRun(self.allocator, &argv) catch return error.ServiceStopFailed;
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        const ok = switch (result.term) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!ok) return error.ServiceStopFailed;
    }

    fn launchdStatus(self: *ServiceController, service_name: []const u8) !definitions.ServiceStatus {
        const label = try self.getLaunchdLabel(service_name);
        defer self.allocator.free(label);

        const argv = [_][]const u8{ "launchctl", "list", label };
        const result = io_helper.childRun(self.allocator, &argv) catch return .stopped;
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        // `launchctl list <label>` exits non-zero when the label isn't loaded.
        const loaded = switch (result.term) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!loaded) return .stopped;

        // The job is registered, but that does NOT mean it's running — a unit
        // that exits immediately (e.g. a bad config, exit 78) stays registered.
        // A live "PID" key means it's actually running; otherwise a non-zero
        // "LastExitStatus" means it bounced (failed). Checking exit code alone
        // (the old behaviour) reported "running" for dead jobs.
        if (std.mem.indexOf(u8, result.stdout, "\"PID\" =") != null or
            std.mem.indexOf(u8, result.stdout, "\"PID\"=") != null)
        {
            return .running;
        }
        if (lastExitStatusNonZero(result.stdout)) return .failed;
        return .stopped;
    }

    /// Parse the integer after `"LastExitStatus" =` in `launchctl list` output
    /// and report whether it is non-zero (i.e. the job exited with an error).
    fn lastExitStatusNonZero(output: []const u8) bool {
        const key = "\"LastExitStatus\" =";
        const key_pos = std.mem.indexOf(u8, output, key) orelse return false;
        var i = key_pos + key.len;
        while (i < output.len and (output[i] == ' ' or output[i] == '\t')) : (i += 1) {}
        var value: i64 = 0;
        var saw_digit = false;
        while (i < output.len and output[i] >= '0' and output[i] <= '9') : (i += 1) {
            value = value * 10 + @as(i64, output[i] - '0');
            saw_digit = true;
        }
        return saw_digit and value != 0;
    }

    fn getLaunchdServiceFile(self: *ServiceController, service_name: []const u8) ![]const u8 {
        const label = try self.getLaunchdLabel(service_name);
        defer self.allocator.free(label);

        const service_dir = try self.platform.userServiceDirectory(self.allocator);
        defer self.allocator.free(service_dir);

        return try std.fmt.allocPrint(
            self.allocator,
            "{s}/{s}.plist",
            .{ service_dir, label },
        );
    }

    fn getLaunchdLabel(self: *ServiceController, service_name: []const u8) ![]const u8 {
        return try std.fmt.allocPrint(
            self.allocator,
            "com.pantry.{s}",
            .{service_name},
        );
    }

    // ========================================================================
    // Linux systemd implementation
    // ========================================================================

    /// Run `systemctl [--user] <verb> <unit>` (the `--user` flag is added only in
    /// user scope) and report whether it exited 0.
    fn runSystemctl(self: *ServiceController, verb: []const u8, unit: []const u8) !bool {
        const result = switch (self.scope) {
            .user => try io_helper.spawnAndWait(.{ .argv = &[_][]const u8{ "systemctl", "--user", verb, unit } }),
            .system => try io_helper.spawnAndWait(.{ .argv = &[_][]const u8{ "systemctl", verb, unit } }),
        };
        return switch (result) {
            .exited => |code| code == 0,
            else => false,
        };
    }

    /// Reload the relevant systemd manager so a freshly written unit is picked
    /// up before start/enable. Best-effort — a failure here surfaces on the
    /// subsequent start.
    pub fn systemdDaemonReload(self: *ServiceController) void {
        _ = switch (self.scope) {
            .user => io_helper.spawnAndWait(.{ .argv = &[_][]const u8{ "systemctl", "--user", "daemon-reload" } }),
            .system => io_helper.spawnAndWait(.{ .argv = &[_][]const u8{ "systemctl", "daemon-reload" } }),
        } catch return;
    }

    fn systemdStart(self: *ServiceController, service_name: []const u8) !void {
        const service_unit = try self.getSystemdUnit(service_name);
        defer self.allocator.free(service_unit);
        if (!try self.runSystemctl("start", service_unit)) return error.ServiceStartFailed;
    }

    fn systemdStop(self: *ServiceController, service_name: []const u8) !void {
        const service_unit = try self.getSystemdUnit(service_name);
        defer self.allocator.free(service_unit);
        if (!try self.runSystemctl("stop", service_unit)) return error.ServiceStopFailed;
    }

    fn systemdEnable(self: *ServiceController, service_name: []const u8) !void {
        const service_unit = try self.getSystemdUnit(service_name);
        defer self.allocator.free(service_unit);
        if (!try self.runSystemctl("enable", service_unit)) return error.ServiceEnableFailed;
    }

    fn systemdDisable(self: *ServiceController, service_name: []const u8) !void {
        const service_unit = try self.getSystemdUnit(service_name);
        defer self.allocator.free(service_unit);
        if (!try self.runSystemctl("disable", service_unit)) return error.ServiceDisableFailed;
    }

    fn systemdStatus(self: *ServiceController, service_name: []const u8) !definitions.ServiceStatus {
        const service_unit = try self.getSystemdUnit(service_name);
        defer self.allocator.free(service_unit);

        const result = switch (self.scope) {
            .user => try io_helper.childRun(self.allocator, &[_][]const u8{ "systemctl", "--user", "is-active", service_unit }),
            .system => try io_helper.childRun(self.allocator, &[_][]const u8{ "systemctl", "is-active", service_unit }),
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        const output = std.mem.trim(u8, result.stdout, &std.ascii.whitespace);

        if (std.mem.eql(u8, output, "active")) {
            return .running;
        } else if (std.mem.eql(u8, output, "inactive")) {
            return .stopped;
        } else if (std.mem.eql(u8, output, "failed")) {
            return .failed;
        }

        return .unknown;
    }

    fn getSystemdUnit(self: *ServiceController, service_name: []const u8) ![]const u8 {
        return try std.fmt.allocPrint(
            self.allocator,
            "pantry-{s}.service",
            .{service_name},
        );
    }

    /// Caller-owned directory the systemd unit is written to for the active
    /// scope: `/etc/systemd/system` for system services, the per-user dir
    /// (`~/.config/systemd/user`) otherwise.
    pub fn systemdUnitDirectory(self: *ServiceController) ![]const u8 {
        return switch (self.scope) {
            .system => try self.allocator.dupe(u8, "/etc/systemd/system"),
            .user => try self.platform.userServiceDirectory(self.allocator),
        };
    }

    /// The `WantedBy=` install target for the active scope. The per-user manager
    /// has no `multi-user.target`, so user units anchor to `default.target`.
    pub fn systemdWantedBy(self: *ServiceController) []const u8 {
        return switch (self.scope) {
            .system => "multi-user.target",
            .user => "default.target",
        };
    }

    // ========================================================================
    // FreeBSD rc.d implementation
    // ========================================================================

    fn rcdStart(self: *ServiceController, service_name: []const u8) !void {
        const rcd_name = try self.getRcdName(service_name);
        defer self.allocator.free(rcd_name);

        const argv = [_][]const u8{ "service", rcd_name, "onestart" };
        const result = try io_helper.spawnAndWait(.{ .argv = &argv });

        const ok = switch (result) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!ok) return error.ServiceStartFailed;
    }

    fn rcdStop(self: *ServiceController, service_name: []const u8) !void {
        const rcd_name = try self.getRcdName(service_name);
        defer self.allocator.free(rcd_name);

        const argv = [_][]const u8{ "service", rcd_name, "onestop" };
        const result = try io_helper.spawnAndWait(.{ .argv = &argv });

        const ok = switch (result) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!ok) return error.ServiceStopFailed;
    }

    fn rcdEnable(self: *ServiceController, service_name: []const u8) !void {
        const rcd_name = try self.getRcdName(service_name);
        defer self.allocator.free(rcd_name);

        // Enable via sysrc: sysrc pantry_<name>_enable=YES
        const var_name = try std.fmt.allocPrint(self.allocator, "{s}_enable=YES", .{rcd_name});
        defer self.allocator.free(var_name);

        const argv = [_][]const u8{ "sysrc", var_name };
        const result = try io_helper.spawnAndWait(.{ .argv = &argv });

        const ok = switch (result) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!ok) return error.ServiceEnableFailed;
    }

    fn rcdDisable(self: *ServiceController, service_name: []const u8) !void {
        const rcd_name = try self.getRcdName(service_name);
        defer self.allocator.free(rcd_name);

        // Disable via sysrc: sysrc pantry_<name>_enable=NO
        const var_name = try std.fmt.allocPrint(self.allocator, "{s}_enable=NO", .{rcd_name});
        defer self.allocator.free(var_name);

        const argv = [_][]const u8{ "sysrc", var_name };
        const result = try io_helper.spawnAndWait(.{ .argv = &argv });

        const ok = switch (result) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!ok) return error.ServiceDisableFailed;
    }

    fn rcdStatus(self: *ServiceController, service_name: []const u8) !definitions.ServiceStatus {
        const rcd_name = try self.getRcdName(service_name);
        defer self.allocator.free(rcd_name);

        const argv = [_][]const u8{ "service", rcd_name, "status" };
        const result = try io_helper.childRun(self.allocator, &argv);
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        // rc.d status returns 0 if running, non-zero if stopped
        return switch (result.term) {
            .exited => |code| if (code == 0) .running else .stopped,
            else => .unknown,
        };
    }

    fn getRcdName(self: *ServiceController, service_name: []const u8) ![]const u8 {
        return try std.fmt.allocPrint(
            self.allocator,
            "pantry_{s}",
            .{service_name},
        );
    }
};

test "Platform detection" {
    const platform = Platform.detect();

    // Should detect a known platform
    try std.testing.expect(platform != .unknown);

    // Check service manager name
    const manager = platform.serviceManager();
    try std.testing.expect(manager.len > 0);
}

test "ServiceController init" {
    const allocator = std.testing.allocator;

    const controller = ServiceController.init(allocator);
    try std.testing.expect(controller.platform != .unknown);
}
