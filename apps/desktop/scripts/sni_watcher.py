#!/usr/bin/env python3
# A minimal StatusNotifierWatcher for the tray smoke run (Linux). It accepts tray items. For each
# one it waits until the app has ticked "Mute notifications", prints the item's title, tooltip,
# icon sizes and menu, clicks the icon and "Mute notifications", waits until the tick is gone,
# prints the menu again and clicks "Quit RChat". Needs python3-dbus and python3-gi.
import sys

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

WATCHER = "org.kde.StatusNotifierWatcher"
ITEM = "org.kde.StatusNotifierItem"
MENU = "com.canonical.dbusmenu"
PROPS = "org.freedesktop.DBus.Properties"
MUTE = "Mute notifications"
QUIT = "Quit RChat"
# The app changes its menu a moment after it starts or is clicked, sooner or later with the
# machine's load. The menu is read every POLL_MS, up to POLLS times (10 s).
POLL_MS = 250
POLLS = 40


def say(*parts):
    print(*parts, flush=True)


def fail(error):
    say("error", error.get_dbus_name(), error.get_dbus_message())


def walk(node, depth=0):
    _id, props, children = node
    if depth > 0:
        kind = props.get("type", "standard")
        label = str(props.get("label", "")).replace("__", "_")
        enabled = bool(props.get("enabled", True))
        toggle = int(props.get("toggle-state", -1))
        yield int(_id), depth, kind, label, enabled, toggle
    for child in children:
        yield from walk(child, depth + 1)


def show(rows):
    for _id, depth, kind, label, enabled, toggle in rows:
        say("menu", "  " * (depth - 1) + (label or "-" * 8), kind, "on" if enabled else "off", toggle)


def click(menu, rows, wanted):
    for _id, _depth, _kind, label, _enabled, _toggle in rows:
        if label == wanted:
            menu.Event(dbus.Int32(_id), "clicked", dbus.Int32(0, variant_level=1), dbus.UInt32(0))
            say("clicked", wanted)
            return True
    return False


class Watcher(dbus.service.Object):
    def __init__(self, bus):
        self.bus = bus
        self.items = []
        name = dbus.service.BusName(WATCHER, bus)
        super().__init__(name, "/StatusNotifierWatcher")

    @dbus.service.method(WATCHER, in_signature="s", sender_keyword="sender")
    def RegisterStatusNotifierItem(self, service, sender=None):
        name, path = (sender, service) if service.startswith("/") else (service, "/StatusNotifierItem")
        self.items.append(name + path)
        say("registered", name, path)
        self.StatusNotifierItemRegistered(name + path)
        self.inspect(name, path)

    @dbus.service.method(WATCHER, in_signature="s")
    def RegisterStatusNotifierHost(self, service):
        pass

    @dbus.service.signal(WATCHER, signature="s")
    def StatusNotifierItemRegistered(self, service):
        pass

    def props(self):
        return {
            "RegisteredStatusNotifierItems": dbus.Array(self.items, signature="s"),
            "IsStatusNotifierHostRegistered": dbus.Boolean(True),
            "ProtocolVersion": dbus.Int32(0),
        }

    @dbus.service.method(PROPS, in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        return self.props()[prop]

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.props()

    def read(self, name, path):
        item = self.bus.get_object(name, path)
        props = dbus.Interface(item, PROPS)
        menu = dbus.Interface(self.bus.get_object(name, props.Get(ITEM, "Menu")), MENU)
        _rev, layout = menu.GetLayout(0, -1, dbus.Array([], signature="s"))
        return item, props, menu, list(walk(layout))

    # Calls `then` once Mute has the wanted tick. After the last poll it calls it with the menu
    # as it is, so the log shows what the app got to.
    def when_mute_is(self, want, name, path, then, left=POLLS):
        found = None
        try:
            found = self.read(name, path)
        except dbus.DBusException as e:
            if left <= 1:
                fail(e)
        ticks = [row[5] for row in found[3] if row[3] == MUTE] if found else []
        if found and (ticks == [want] or left <= 1):
            try:
                then(*found)
            except dbus.DBusException as e:
                fail(e)
        elif left > 1:
            GLib.timeout_add(POLL_MS, self.when_mute_is, want, name, path, then, left - 1)
        return False

    def inspect(self, name, path):
        def unmuted(_item, _props, menu, rows):
            show(rows)
            click(menu, rows, QUIT)

        def started(item, props, menu, rows):
            say("title", props.Get(ITEM, "Title"))
            tip = props.Get(ITEM, "ToolTip")
            say("tooltip", tip[2], "|", tip[3])
            sizes = [f"{w}x{h}" for w, h, _data in props.Get(ITEM, "IconPixmap")]
            say("icon", " ".join(sizes))
            show(rows)
            dbus.Interface(item, ITEM).Activate(dbus.Int32(0), dbus.Int32(0))
            say("clicked icon")
            if click(menu, rows, MUTE):
                GLib.timeout_add(POLL_MS, self.when_mute_is, 0, name, path, unmuted)

        GLib.timeout_add(POLL_MS, self.when_mute_is, 1, name, path, started)


def main():
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    Watcher(bus)
    say("ready")
    GLib.MainLoop().run()


if __name__ == "__main__":
    sys.exit(main())
