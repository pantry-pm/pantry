const std = @import("std");
const definitions = @import("definitions.zig");
const platform = @import("platform.zig");
const logs = @import("logs.zig");
const io_helper = @import("../io_helper.zig");

/// Write `s` to the buffer, escaping the five XML predefined entities so that
/// a user-supplied service name / log path / argument can't break out of the
/// plist template (`<string>foo</string>` with `foo` = `"&bar"`).
fn writeXmlEscaped(buf: *std.ArrayList(u8), allocator: std.mem.Allocator, s: []const u8) !void {
    for (s) |c| {
        switch (c) {
            '&' => try buf.appendSlice(allocator, "&amp;"),
            '<' => try buf.appendSlice(allocator, "&lt;"),
            '>' => try buf.appendSlice(allocator, "&gt;"),
            '"' => try buf.appendSlice(allocator, "&quot;"),
            '\'' => try buf.appendSlice(allocator, "&apos;"),
            else => try buf.append(allocator, c),
        }
    }
}

/// Shell-style (shlex) argv splitter — handles single- and double-quoted
/// segments and backslash escapes, matching what Bun / Node / launchd's
/// ProgramArguments expect. Returns a caller-owned slice of owned strings.
pub fn splitShellArgs(allocator: std.mem.Allocator, cmd: []const u8) ![][]const u8 {
    var args = std.ArrayList([]const u8).empty;
    errdefer {
        for (args.items) |a| allocator.free(a);
        args.deinit(allocator);
    }

    var current = std.ArrayList(u8).empty;
    defer current.deinit(allocator);

    var i: usize = 0;
    var in_single = false;
    var in_double = false;
    var has_content = false;

    while (i < cmd.len) : (i += 1) {
        const c = cmd[i];
        if (in_single) {
            if (c == '\'') {
                in_single = false;
            } else {
                try current.append(allocator, c);
                has_content = true;
            }
        } else if (in_double) {
            if (c == '"') {
                in_double = false;
            } else if (c == '\\' and i + 1 < cmd.len) {
                // Inside double quotes, \\ \" \$ \` \n are escapes; anything
                // else keeps the backslash literal. Keep it simple: pass
                // through the next char.
                i += 1;
                try current.append(allocator, cmd[i]);
                has_content = true;
            } else {
                try current.append(allocator, c);
                has_content = true;
            }
        } else {
            switch (c) {
                ' ', '\t', '\n', '\r' => {
                    if (has_content) {
                        const owned = try allocator.dupe(u8, current.items);
                        try args.append(allocator, owned);
                        current.clearRetainingCapacity();
                        has_content = false;
                    }
                },
                '\'' => {
                    in_single = true;
                    has_content = true;
                },
                '"' => {
                    in_double = true;
                    has_content = true;
                },
                '\\' => {
                    if (i + 1 < cmd.len) {
                        i += 1;
                        try current.append(allocator, cmd[i]);
                        has_content = true;
                    }
                },
                else => {
                    try current.append(allocator, c);
                    has_content = true;
                },
            }
        }
    }
    if (has_content) {
        const owned = try allocator.dupe(u8, current.items);
        try args.append(allocator, owned);
    }

    return args.toOwnedSlice(allocator);
}

pub const ServiceManager = struct {
    allocator: std.mem.Allocator,
    controller: platform.ServiceController,
    services: std.StringHashMap(*definitions.ServiceConfig),

    pub fn init(allocator: std.mem.Allocator) ServiceManager {
        return .{
            .allocator = allocator,
            .controller = platform.ServiceController.init(allocator),
            .services = std.StringHashMap(*definitions.ServiceConfig).init(allocator),
        };
    }

    pub fn deinit(self: *ServiceManager) void {
        var it = self.services.iterator();
        while (it.next()) |entry| {
            entry.value_ptr.*.deinit(self.allocator);
            self.allocator.destroy(entry.value_ptr.*);
        }
        self.services.deinit();
    }

    /// Register a service
    pub fn register(self: *ServiceManager, config: definitions.ServiceConfig) !void {
        // Check if service already exists and free it
        if (self.services.fetchRemove(config.name)) |kv| {
            kv.value.deinit(self.allocator);
            self.allocator.destroy(kv.value);
        }

        const service_ptr = try self.allocator.create(definitions.ServiceConfig);
        service_ptr.* = config;

        try self.services.put(config.name, service_ptr);
    }

    /// Unregister a service
    pub fn unregister(self: *ServiceManager, service_name: []const u8) !void {
        if (self.services.fetchRemove(service_name)) |kv| {
            kv.value.deinit(self.allocator);
            self.allocator.destroy(kv.value);
        } else {
            return error.ServiceNotFound;
        }
    }

    /// Get service configuration
    pub fn getService(self: *ServiceManager, service_name: []const u8) ?*definitions.ServiceConfig {
        return self.services.get(service_name);
    }

    /// List all registered services
    pub fn listServices(self: *ServiceManager) ![]*definitions.ServiceConfig {
        const count = self.services.count();
        const result = try self.allocator.alloc(*definitions.ServiceConfig, count);

        var i: usize = 0;
        var it = self.services.valueIterator();
        while (it.next()) |service| : (i += 1) {
            result[i] = service.*;
        }

        return result;
    }

    /// Start a service
    pub fn start(self: *ServiceManager, service_name: []const u8) !void {
        const service = self.services.get(service_name) orelse return error.ServiceNotFound;

        // Roll oversized logs while nothing holds them open. Once the process
        // manager spawns the service it keeps the log descriptor for the
        // process's life, so this instant — after the previous run has exited
        // and before the next one starts — is the only free rotation there is.
        _ = logs.rotateService(
            self.allocator,
            service.name,
            service.project_id,
            logs.Policy.fromEnv(self.allocator),
        );

        // Generate service file if it doesn't exist
        try self.ensureServiceFile(service);

        // Pick up a freshly written unit before starting (system/user systemd
        // both need a daemon-reload; no-op on platforms without systemctl).
        if (platform.Platform.detect() == .linux) self.controller.systemdDaemonReload();

        // Start the service under the same label/unit the file was generated
        // with (project-scoped when the config carries a project_id).
        try self.controller.start(service_name, service.project_id);
    }

    /// Stop a service
    pub fn stop(self: *ServiceManager, service_name: []const u8) !void {
        const service = self.services.get(service_name) orelse return error.ServiceNotFound;
        try self.controller.stop(service_name, service.project_id);
    }

    /// Restart a service
    pub fn restart(self: *ServiceManager, service_name: []const u8) !void {
        const service = self.services.get(service_name) orelse return error.ServiceNotFound;
        _ = logs.rotateService(
            self.allocator,
            service.name,
            service.project_id,
            logs.Policy.fromEnv(self.allocator),
        );
        try self.controller.restart(service_name, service.project_id);
    }

    /// Get service status
    pub fn status(self: *ServiceManager, service_name: []const u8) !definitions.ServiceStatus {
        const service = self.services.get(service_name) orelse return error.ServiceNotFound;
        return try self.controller.status(service_name, service.project_id);
    }

    /// Check if service is running
    pub fn isRunning(self: *ServiceManager, service_name: []const u8) !bool {
        const service = self.services.get(service_name) orelse return error.ServiceNotFound;
        return try self.controller.isRunning(service_name, service.project_id);
    }

    /// Generate service file for the current platform
    fn ensureServiceFile(self: *ServiceManager, service: *definitions.ServiceConfig) !void {
        const plat = platform.Platform.detect();

        switch (plat) {
            .macos => try self.generateLaunchdPlist(service),
            .linux => try self.generateSystemdUnit(service),
            .freebsd => try self.generateRcdScript(service),
            .windows => return error.UnsupportedPlatform,
            .unknown => return error.UnsupportedPlatform,
        }
    }

    /// Generate launchd plist file for macOS
    fn generateLaunchdPlist(self: *ServiceManager, service: *definitions.ServiceConfig) !void {
        const label = if (service.project_id) |pid|
            try std.fmt.allocPrint(self.allocator, "com.pantry.{s}.{s}", .{ pid, service.name })
        else
            try std.fmt.allocPrint(self.allocator, "com.pantry.{s}", .{service.name});
        defer self.allocator.free(label);

        // Use user LaunchAgents directory instead of system LaunchDaemons
        const plat = platform.Platform.detect();
        const service_dir = try plat.userServiceDirectory(self.allocator);
        defer self.allocator.free(service_dir);

        // Ensure directory exists
        try io_helper.makePath(service_dir);

        const plist_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/{s}.plist",
            .{ service_dir, label },
        );
        defer self.allocator.free(plist_path);

        // Always regenerate the plist to pick up config changes
        {
            // Delete existing plist if present (ignore errors if it doesn't exist)
            io_helper.deleteFile(plist_path) catch {};
            const file = try io_helper.createFile(plist_path, .{});
            defer file.close(io_helper.io);

            try io_helper.writeAllToFile(file, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
            try io_helper.writeAllToFile(file, "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
            try io_helper.writeAllToFile(file, "<plist version=\"1.0\">\n");
            try io_helper.writeAllToFile(file, "<dict>\n");

            // XML-escape label (user-controlled) so a service named `foo<bar&`
            // can't break out of the <string> element.
            {
                var label_buf = std.ArrayList(u8).empty;
                defer label_buf.deinit(self.allocator);
                try label_buf.appendSlice(self.allocator, "    <key>Label</key>\n    <string>");
                try writeXmlEscaped(&label_buf, self.allocator, label);
                try label_buf.appendSlice(self.allocator, "</string>\n");
                try io_helper.writeAllToFile(file, label_buf.items);
            }

            // Split start_command into individual ProgramArguments. Uses a
            // shell-aware splitter so `mytool "path with spaces" --arg='v k'`
            // becomes 3 args instead of 4 or 5. Each arg is XML-escaped so
            // literal `<` / `&` / `"` in user service definitions can't break
            // the plist template.
            try io_helper.writeAllToFile(file, "    <key>ProgramArguments</key>\n    <array>\n");
            const parsed_args = try splitShellArgs(self.allocator, service.start_command);
            defer {
                for (parsed_args) |a| self.allocator.free(a);
                self.allocator.free(parsed_args);
            }
            for (parsed_args) |arg| {
                if (arg.len == 0) continue;
                var line_buf = std.ArrayList(u8).empty;
                defer line_buf.deinit(self.allocator);
                try line_buf.appendSlice(self.allocator, "        <string>");
                try writeXmlEscaped(&line_buf, self.allocator, arg);
                try line_buf.appendSlice(self.allocator, "</string>\n");
                try io_helper.writeAllToFile(file, line_buf.items);
            }
            try io_helper.writeAllToFile(file, "    </array>\n");

            if (service.working_directory) |wd| {
                var wd_buf = std.ArrayList(u8).empty;
                defer wd_buf.deinit(self.allocator);
                try wd_buf.appendSlice(self.allocator, "    <key>WorkingDirectory</key>\n    <string>");
                try writeXmlEscaped(&wd_buf, self.allocator, wd);
                try wd_buf.appendSlice(self.allocator, "</string>\n");
                try io_helper.writeAllToFile(file, wd_buf.items);
            }

            if (service.keep_alive) {
                try io_helper.writeAllToFile(file, "    <key>KeepAlive</key>\n    <true/>\n");
                // launchd's default respawn floor is 10s, which for a service
                // that can never start (a port another project already holds)
                // is six restarts a minute writing a full startup banner
                // each — forever, since nothing about a KeepAlive job needs a
                // human. Widening the floor doesn't fix the loop, but it
                // costs a crash-looping service two thirds of its output.
                try io_helper.writeAllToFile(file, "    <key>ThrottleInterval</key>\n    <integer>30</integer>\n");
            }

            if (service.auto_start) {
                try io_helper.writeAllToFile(file, "    <key>RunAtLoad</key>\n    <true/>\n");
            }

            // Log file paths
            {
                const home_env = io_helper.getEnvVarOwned(self.allocator, "HOME") catch null;
                defer if (home_env) |h| self.allocator.free(h);

                if (home_env) |h| {
                    const logs_dir = if (service.project_id) |pid|
                        try std.fmt.allocPrint(self.allocator, "{s}/.local/share/pantry/logs/{s}", .{ h, pid })
                    else
                        try std.fmt.allocPrint(self.allocator, "{s}/.local/share/pantry/logs", .{h});
                    defer self.allocator.free(logs_dir);
                    io_helper.makePath(logs_dir) catch {};

                    var out_buf = std.ArrayList(u8).empty;
                    defer out_buf.deinit(self.allocator);
                    try out_buf.appendSlice(self.allocator, "    <key>StandardOutPath</key>\n    <string>");
                    try writeXmlEscaped(&out_buf, self.allocator, logs_dir);
                    try out_buf.append(self.allocator, '/');
                    try writeXmlEscaped(&out_buf, self.allocator, service.name);
                    try out_buf.appendSlice(self.allocator, ".log</string>\n");
                    try io_helper.writeAllToFile(file, out_buf.items);

                    var err_buf = std.ArrayList(u8).empty;
                    defer err_buf.deinit(self.allocator);
                    try err_buf.appendSlice(self.allocator, "    <key>StandardErrorPath</key>\n    <string>");
                    try writeXmlEscaped(&err_buf, self.allocator, logs_dir);
                    try err_buf.append(self.allocator, '/');
                    try writeXmlEscaped(&err_buf, self.allocator, service.name);
                    try err_buf.appendSlice(self.allocator, ".err</string>\n");
                    try io_helper.writeAllToFile(file, err_buf.items);
                }
            }

            // Environment variables. PANTRY_PROJECT_ROOT rides along so the
            // unit records which directory it belongs to; `services:prune`
            // reads it back to find units whose project no longer exists.
            if (service.env_vars.count() > 0 or service.project_root != null) {
                try io_helper.writeAllToFile(file, "    <key>EnvironmentVariables</key>\n    <dict>\n");

                if (service.project_root) |root| {
                    var root_buf = std.ArrayList(u8).empty;
                    defer root_buf.deinit(self.allocator);
                    try root_buf.appendSlice(self.allocator, "        <key>PANTRY_PROJECT_ROOT</key>\n        <string>");
                    try writeXmlEscaped(&root_buf, self.allocator, root);
                    try root_buf.appendSlice(self.allocator, "</string>\n");
                    try io_helper.writeAllToFile(file, root_buf.items);
                }

                var it = service.env_vars.iterator();
                while (it.next()) |entry| {
                    const env_line = try std.fmt.allocPrint(self.allocator, "        <key>{s}</key>\n        <string>{s}</string>\n", .{
                        entry.key_ptr.*,
                        entry.value_ptr.*,
                    });
                    defer self.allocator.free(env_line);
                    try io_helper.writeAllToFile(file, env_line);
                }

                try io_helper.writeAllToFile(file, "    </dict>\n");
            }

            try io_helper.writeAllToFile(file, "</dict>\n");
            try io_helper.writeAllToFile(file, "</plist>\n");
        }
    }

    /// Generate systemd unit file for Linux
    fn generateSystemdUnit(self: *ServiceManager, service: *definitions.ServiceConfig) !void {
        const unit_name = if (service.project_id) |pid|
            try std.fmt.allocPrint(self.allocator, "pantry-{s}-{s}.service", .{ pid, service.name })
        else
            try std.fmt.allocPrint(self.allocator, "pantry-{s}.service", .{service.name});
        defer self.allocator.free(unit_name);

        // Scope-aware unit directory: /etc/systemd/system for system services
        // (root / servers), ~/.config/systemd/user for per-user dev services.
        const service_dir = try self.controller.systemdUnitDirectory();
        defer self.allocator.free(service_dir);

        // Ensure directory exists
        try io_helper.makePath(service_dir);

        const unit_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/{s}",
            .{ service_dir, unit_name },
        );
        defer self.allocator.free(unit_path);

        // Check if file already exists
        io_helper.access(unit_path, .{}) catch {
            // File doesn't exist, create it
            const file = try io_helper.createFile(unit_path, .{});
            defer io_helper.closeFile(file);

            try io_helper.writeAllToFile(file, "[Unit]\n");

            const desc_line = try std.fmt.allocPrint(self.allocator, "Description={s}\n", .{service.description});
            defer self.allocator.free(desc_line);
            try io_helper.writeAllToFile(file, desc_line);

            try io_helper.writeAllToFile(file, "After=network.target\n");

            // Stop restarting a service that cannot start. Without a start
            // limit, Restart=always turns an unsatisfiable service (a port
            // already taken, a missing data dir) into an unbounded loop whose
            // only trace is a log file that grows until the disk is gone.
            // Ten attempts in five minutes is well past a transient failure.
            try io_helper.writeAllToFile(file, "StartLimitIntervalSec=300\n");
            try io_helper.writeAllToFile(file, "StartLimitBurst=10\n\n");

            try io_helper.writeAllToFile(file, "[Service]\n");

            const exec_line = try std.fmt.allocPrint(self.allocator, "ExecStart={s}\n", .{service.start_command});
            defer self.allocator.free(exec_line);
            try io_helper.writeAllToFile(file, exec_line);

            if (service.working_directory) |wd| {
                const wd_line = try std.fmt.allocPrint(self.allocator, "WorkingDirectory={s}\n", .{wd});
                defer self.allocator.free(wd_line);
                try io_helper.writeAllToFile(file, wd_line);
            }

            if (service.keep_alive) {
                try io_helper.writeAllToFile(file, "Restart=always\n");
                try io_helper.writeAllToFile(file, "RestartSec=3\n");
            }

            // Log file paths
            {
                const home_env = io_helper.getEnvVarOwned(self.allocator, "HOME") catch null;
                defer if (home_env) |h| self.allocator.free(h);

                if (home_env) |h| {
                    const logs_dir = if (service.project_id) |pid|
                        try std.fmt.allocPrint(self.allocator, "{s}/.local/share/pantry/logs/{s}", .{ h, pid })
                    else
                        try std.fmt.allocPrint(self.allocator, "{s}/.local/share/pantry/logs", .{h});
                    defer self.allocator.free(logs_dir);
                    io_helper.makePath(logs_dir) catch {};

                    const stdout_line = try std.fmt.allocPrint(self.allocator, "StandardOutput=append:{s}/{s}.log\n", .{ logs_dir, service.name });
                    defer self.allocator.free(stdout_line);
                    try io_helper.writeAllToFile(file, stdout_line);

                    const stderr_line = try std.fmt.allocPrint(self.allocator, "StandardError=append:{s}/{s}.err\n", .{ logs_dir, service.name });
                    defer self.allocator.free(stderr_line);
                    try io_helper.writeAllToFile(file, stderr_line);
                }
            }

            // Environment variables. See the launchd branch: the project root
            // is recorded so `services:prune` can spot a unit whose project
            // directory has been deleted.
            if (service.project_root) |root| {
                const root_line = try std.fmt.allocPrint(self.allocator, "Environment=\"PANTRY_PROJECT_ROOT={s}\"\n", .{root});
                defer self.allocator.free(root_line);
                try io_helper.writeAllToFile(file, root_line);
            }

            var it = service.env_vars.iterator();
            while (it.next()) |entry| {
                const env_line = try std.fmt.allocPrint(self.allocator, "Environment=\"{s}={s}\"\n", .{
                    entry.key_ptr.*,
                    entry.value_ptr.*,
                });
                defer self.allocator.free(env_line);
                try io_helper.writeAllToFile(file, env_line);
            }

            // LD_LIBRARY_PATH so the service binary (exec'd directly, not via a
            // shim or `pantry env`) can load its dependencies' shared libraries.
            // Without it, lib-dependent services (php-fpm, nginx, …) crash-loop
            // with status=127. Scanned from the project's pantry tree.
            self.writeLibraryPathEnv(file, service.start_command) catch {};

            // An empty [Install] makes `systemctl enable` fail outright, so
            // always anchor to the scope's target: multi-user.target for system
            // units (boot-time start), default.target for the per-user manager
            // (which has no multi-user.target). Whether pantry CALLS enable is
            // governed by auto_start / `pantry services enable`, not unit shape.
            const wanted_by = self.controller.systemdWantedBy();
            const install_line = try std.fmt.allocPrint(self.allocator, "\n[Install]\nWantedBy={s}\n", .{wanted_by});
            defer self.allocator.free(install_line);
            try io_helper.writeAllToFile(file, install_line);
        };
    }

    /// Write an `Environment="LD_LIBRARY_PATH=…"` line covering every installed
    /// package's `lib` dir, so a directly-exec'd service binary finds its
    /// dependencies' shared libraries. The project's `pantry/` root is derived
    /// from the service binary path in `start_command`. Best-effort.
    fn writeLibraryPathEnv(self: *ServiceManager, file: anytype, start_command: []const u8) !void {
        // Find the pantry INSTALL root anywhere in the command, not just the
        // leading binary — wrapper commands like `/bin/sh -c '… /opt/pantry/
        // pantry/<pkg>/bin/x …'` (postgres) have the real binary mid-string.
        // A command can contain several `/pantry/` substrings (e.g. the data dir
        // `/var/lib/pantry/postgres`), so try each candidate root and keep the
        // first that actually contains package version dirs with `lib/`.
        const marker = "/pantry/";
        var libs = std.ArrayList(u8).empty;
        defer libs.deinit(self.allocator);

        var search_from: usize = 0;
        while (std.mem.indexOfPos(u8, start_command, search_from, marker)) |idx| {
            search_from = idx + marker.len;
            const root = start_command[0 .. idx + marker.len - 1]; // up to & incl. "/pantry"
            libs.clearRetainingCapacity();
            self.scanLibDirs(root, 0, &libs);
            if (libs.items.len > 0) break;
        }
        if (libs.items.len == 0) return;

        // Drop the trailing ':' appended after the last entry.
        const joined = if (libs.items[libs.items.len - 1] == ':') libs.items[0 .. libs.items.len - 1] else libs.items;
        if (joined.len == 0) return;

        const line = try std.fmt.allocPrint(self.allocator, "Environment=\"LD_LIBRARY_PATH={s}\"\n", .{joined});
        defer self.allocator.free(line);
        try io_helper.writeAllToFile(file, line);
    }

    /// Append (`dir:`-separated) every package version dir's `lib/` under
    /// `dir_path` to `out`. Recurses domain dirs until a `v<digit>…` version
    /// dir, bounded depth.
    fn scanLibDirs(self: *ServiceManager, dir_path: []const u8, depth: u32, out: *std.ArrayList(u8)) void {
        if (depth > 5) return;
        var dir = io_helper.openDirForIteration(dir_path) catch return;
        defer dir.close();
        var it = dir.iterate();
        while (it.next() catch null) |entry| {
            if (entry.kind != .directory or entry.name.len == 0 or entry.name[0] == '.') continue;
            const child = std.fs.path.join(self.allocator, &[_][]const u8{ dir_path, entry.name }) catch continue;
            defer self.allocator.free(child);
            const is_version = entry.name.len >= 2 and entry.name[0] == 'v' and entry.name[1] >= '0' and entry.name[1] <= '9';
            if (is_version) {
                const libdir = std.fs.path.join(self.allocator, &[_][]const u8{ child, "lib" }) catch continue;
                defer self.allocator.free(libdir);
                var ld = io_helper.openDirForIteration(libdir) catch continue;
                ld.close();
                out.appendSlice(self.allocator, libdir) catch {};
                out.append(self.allocator, ':') catch {};
            } else {
                self.scanLibDirs(child, depth + 1, out);
            }
        }
    }

    /// Generate FreeBSD rc.d script
    fn generateRcdScript(self: *ServiceManager, service: *definitions.ServiceConfig) !void {
        const script_name = try std.fmt.allocPrint(
            self.allocator,
            "pantry_{s}",
            .{service.name},
        );
        defer self.allocator.free(script_name);

        const service_dir = "/usr/local/etc/rc.d";

        const script_path = try std.fmt.allocPrint(
            self.allocator,
            "{s}/{s}",
            .{ service_dir, script_name },
        );
        defer self.allocator.free(script_path);

        // Check if file already exists
        io_helper.access(script_path, .{}) catch {
            // File doesn't exist, create it
            const file = try io_helper.createFile(script_path, .{});
            defer io_helper.closeFile(file);

            try io_helper.writeAllToFile(file, "#!/bin/sh\n\n");
            try io_helper.writeAllToFile(file, "# PROVIDE: ");
            try io_helper.writeAllToFile(file, script_name);
            try io_helper.writeAllToFile(file, "\n# REQUIRE: DAEMON\n");
            try io_helper.writeAllToFile(file, "# KEYWORD: shutdown\n\n");

            try io_helper.writeAllToFile(file, ". /etc/rc.subr\n\n");

            try io_helper.writeAllToFile(file, "name=\"");
            try io_helper.writeAllToFile(file, script_name);
            try io_helper.writeAllToFile(file, "\"\n");

            const desc_line = try std.fmt.allocPrint(self.allocator, "rcvar=\"{s}_enable\"\n", .{script_name});
            defer self.allocator.free(desc_line);
            try io_helper.writeAllToFile(file, desc_line);

            const cmd_line = try std.fmt.allocPrint(self.allocator, "command=\"{s}\"\n", .{service.start_command});
            defer self.allocator.free(cmd_line);
            try io_helper.writeAllToFile(file, cmd_line);

            if (service.working_directory) |wd| {
                const wd_line = try std.fmt.allocPrint(self.allocator, "{s}_chdir=\"{s}\"\n", .{ script_name, wd });
                defer self.allocator.free(wd_line);
                try io_helper.writeAllToFile(file, wd_line);
            }

            // Environment variables
            var env_buf = std.ArrayList(u8).empty;
            defer env_buf.deinit(self.allocator);
            var it = service.env_vars.iterator();
            var first = true;
            while (it.next()) |entry| {
                if (!first) try env_buf.appendSlice(self.allocator, " ");
                first = false;
                const formatted = try std.fmt.allocPrint(self.allocator, "{s}={s}", .{ entry.key_ptr.*, entry.value_ptr.* });
                defer self.allocator.free(formatted);
                try env_buf.appendSlice(self.allocator, formatted);
            }
            if (env_buf.items.len > 0) {
                const env_line = try std.fmt.allocPrint(self.allocator, "{s}_env=\"{s}\"\n", .{ script_name, env_buf.items });
                defer self.allocator.free(env_line);
                try io_helper.writeAllToFile(file, env_line);
            }

            try io_helper.writeAllToFile(file, "\nrun_rc_command \"$1\"\n");
        };
    }
};

test "ServiceManager init and deinit" {
    const allocator = std.testing.allocator;

    var manager = ServiceManager.init(allocator);
    defer manager.deinit();

    try std.testing.expect(manager.services.count() == 0);
}

test "ServiceManager register and unregister" {
    const allocator = std.testing.allocator;

    var manager = ServiceManager.init(allocator);
    defer manager.deinit();

    // Register a service
    const redis = try definitions.Services.redis(allocator, 6379);
    try manager.register(redis);

    try std.testing.expect(manager.services.count() == 1);

    // Get service
    const service = manager.getService("redis");
    try std.testing.expect(service != null);
    try std.testing.expectEqualStrings("redis", service.?.name);

    // Unregister service
    try manager.unregister("redis");
    try std.testing.expect(manager.services.count() == 0);
}

test "ServiceManager list services" {
    const allocator = std.testing.allocator;

    var manager = ServiceManager.init(allocator);
    defer manager.deinit();

    // Register multiple services
    const redis = try definitions.Services.redis(allocator, 6379);
    try manager.register(redis);

    const pg = try definitions.Services.postgresql(allocator, 5432);
    try manager.register(pg);

    // List services
    const services = try manager.listServices();
    defer allocator.free(services);

    try std.testing.expect(services.len == 2);
}

test "splitShellArgs handles quoted args" {
    const allocator = std.testing.allocator;

    // Spaces inside quotes stay together
    {
        const args = try splitShellArgs(allocator, "bin --arg \"hello world\" --flag");
        defer {
            for (args) |a| allocator.free(a);
            allocator.free(args);
        }
        try std.testing.expectEqual(@as(usize, 4), args.len);
        try std.testing.expectEqualStrings("bin", args[0]);
        try std.testing.expectEqualStrings("--arg", args[1]);
        try std.testing.expectEqualStrings("hello world", args[2]);
        try std.testing.expectEqualStrings("--flag", args[3]);
    }

    // Single quotes preserve literal content
    {
        const args = try splitShellArgs(allocator, "echo 'a b c'");
        defer {
            for (args) |a| allocator.free(a);
            allocator.free(args);
        }
        try std.testing.expectEqual(@as(usize, 2), args.len);
        try std.testing.expectEqualStrings("a b c", args[1]);
    }

    // Plain splitting
    {
        const args = try splitShellArgs(allocator, "a b c");
        defer {
            for (args) |a| allocator.free(a);
            allocator.free(args);
        }
        try std.testing.expectEqual(@as(usize, 3), args.len);
    }
}

test "splitShellArgs empty string returns 0 args" {
    const allocator = std.testing.allocator;
    const args = try splitShellArgs(allocator, "");
    defer {
        for (args) |a| allocator.free(a);
        allocator.free(args);
    }
    try std.testing.expectEqual(@as(usize, 0), args.len);
}

test "splitShellArgs whitespace-only returns 0 args" {
    const allocator = std.testing.allocator;
    const args = try splitShellArgs(allocator, "   \t  \n  ");
    defer {
        for (args) |a| allocator.free(a);
        allocator.free(args);
    }
    try std.testing.expectEqual(@as(usize, 0), args.len);
}

test "splitShellArgs backslash outside quotes" {
    const allocator = std.testing.allocator;
    const args = try splitShellArgs(allocator, "hello\\ world");
    defer {
        for (args) |a| allocator.free(a);
        allocator.free(args);
    }
    try std.testing.expectEqual(@as(usize, 1), args.len);
    try std.testing.expectEqualStrings("hello world", args[0]);
}

test "splitShellArgs adjacent quotes" {
    const allocator = std.testing.allocator;
    const args = try splitShellArgs(allocator, "'hello'\"world\"");
    defer {
        for (args) |a| allocator.free(a);
        allocator.free(args);
    }
    try std.testing.expectEqual(@as(usize, 1), args.len);
    try std.testing.expectEqualStrings("helloworld", args[0]);
}

test "writeXmlEscaped escapes metacharacters" {
    const allocator = std.testing.allocator;
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);
    try writeXmlEscaped(&buf, allocator, "<foo & bar>\"baz\"'qux'");
    try std.testing.expectEqualStrings(
        "&lt;foo &amp; bar&gt;&quot;baz&quot;&apos;qux&apos;",
        buf.items,
    );
}
