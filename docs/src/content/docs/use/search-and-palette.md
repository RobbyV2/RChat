---
title: Search and the command palette
description: Message search, the command palette, its prefixes and its local index, and keyboard shortcuts.
sidebar:
  order: 7
---

## Message search

Search messages looks through the channels you can view in a server, newest first. `from: user` narrows it to one person, and a filter keeps only messages with a file. A result opens its channel at that message. Server search finds servers by name, where the site allows it.

## The command palette

Ctrl+K (⌘K on Apple devices) opens the palette, also from the button on Home and in the phone headers. It finds servers, channels, people and commands as you type. A first character narrows it:

| Prefix | Finds                                                                             |
| ------ | --------------------------------------------------------------------------------- |
| `#`    | Channels                                                                          |
| `@`    | People                                                                            |
| `>`    | Commands                                                                          |
| `/`    | API endpoints, with a console that sends requests as your account (accounts only) |
| `?`    | Help                                                                              |

Enter runs the highlighted entry, and Escape closes the palette.

Settings → Command palette chooses what its search index keeps. Loaded only indexes the messages and members you load, in memory for the session. Full also keeps the index on this device, where it survives a reload. With indexing off, the palette still finds servers, channels, people and commands. Guests can index in memory only.

## Keyboard shortcuts

| Keys                          | Action                                       |
| ----------------------------- | -------------------------------------------- |
| Enter                         | Send the message                             |
| Shift+Enter                   | New line                                     |
| Up                            | Edit your last message (empty message box)   |
| Ctrl+K                        | Open the command palette                     |
| Ctrl+Shift+L                  | Switch account                               |
| Escape                        | Mark the conversation as read, close a panel |
| Shift+Escape                  | Mark everything as read                      |
| Ctrl+Shift+S                  | Select messages                              |
| Ctrl+Click                    | Select or unselect a message                 |
| Shift+Click on the trash icon | Delete without confirming                    |

On Apple devices, ⌘ takes the place of Ctrl. Settings → Information → Keyboard shortcuts lists them all, with the formatting keys of the message box.
