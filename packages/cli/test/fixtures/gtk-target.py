#!/usr/bin/env python3
"""A window with one button and one label, for the CI run that drives a real screen: pressing the button changes the label."""
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

win = Gtk.Window(title="navvied-target")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
label = Gtk.Label(label="idle")
button = Gtk.Button(label="Press")
button.connect("clicked", lambda _b: label.set_text("pressed"))
entry = Gtk.Entry()
box.pack_start(label, True, True, 8)
box.pack_start(button, True, True, 8)
box.pack_start(entry, True, True, 8)
win.add(box)
win.set_default_size(320, 160)
win.connect("destroy", Gtk.main_quit)
win.show_all()
Gtk.main()
