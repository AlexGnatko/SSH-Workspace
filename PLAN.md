# Cross-platform SSH client plan

Build a desktop client for daily work across roughly ten servers. The starting workflow uses PuTTY for terminals and WinSCP for file transfers. After a network outage, each error window has to be closed and each server connection reopened by hand. Start on Windows and extend the interface to Linux and macOS.

## Initial prototype

Validate **Electron + TypeScript + xterm.js + node-pty + OpenSSH** on Windows. xterm.js displays the terminal and handles input. `node-pty` runs the system `ssh` client in a pseudoterminal and forwards input and window dimensions. OpenSSH handles SSH transport, authentication, and server host key verification.

Save connection profiles locally, following the WinSCP model. Each profile stores a name, a hostname or OpenSSH alias, a port, a username, and an optional password. Use system encryption for stored passwords. When OpenSSH prompts for a password, make it possible to enter the saved password with a button or type it manually. Key-based profiles continue to use OpenSSH and the SSH agent.

Give each open profile a tab in the top bar. A profile can contain several independent terminal tabs. Each tab shows its connection state and lets the user interrupt commands or close the session. Add file panels after validating terminal behavior.

### Copy and paste

- Support PuTTY-style copy on mouse selection and paste on right-click. Make both behaviors configurable.
- Use `getSelection()` and `paste()`. Preserve backslashes, quotation marks, spaces, and Cyrillic characters. The remote shell interprets the entered command.
- Copy a long command without inserting line breaks at visual wraps. Honor bracketed paste when the terminal program enables it. Otherwise, ask for confirmation before sending multiline text.
- Test copying to Notepad, pasting from Notepad, and pasting with the right mouse button while an earlier selection remains active. Use a Windows path with spaces and non-ASCII characters, such as `C:\Temp\café notes\file.txt "test"`.

### Connection loss

- Keep the tab open after a network interruption. Show its status and retry with a delay between attempts. Closing the tab or exiting the remote shell cleanly must cancel reconnect attempts.
- Show password or authentication prompts in the tab when needed. Reconnecting must never replay earlier commands.
- Test two open tabs while disconnecting and restoring the network or VPN. Both should reconnect in place when authentication can complete without user input.
- Offer an option to run `tmux new -As work` on a Linux server. When the server stayed up, a new SSH connection can reattach to the same tmux session and recover the previous shell and programs.

### High-volume output

- `cat huge.log` sends output over SSH until it reaches the end of the file or the user interrupts it. Limiting scrollback alone leaves both network traffic and the rendering queue unaffected.
- Limit scrollback and pending output. Pause PTY reads when the queue fills up and resume after the queue drains. Keep input responsive during heavy output, including `Ctrl+C`.
- Run `yes` or print a large test file on a test server. Measure memory usage and check input in an adjacent tab and the response time to `Ctrl+C`.

## After the prototype

- Put servers, groups, and an **Open all** action in the sidebar. Use the center for terminal tabs and split panes. Provide **Computer** and **Server** file panels with SFTP uploads, downloads, and drag-and-drop. Server requirements will determine whether a separate SCP mode is useful.
- Store profiles locally. Use the SSH agent for keys and `known_hosts` for host key verification. Publish the source and support local builds. Keep telemetry and cloud sync out of the app. Handle process and file operations in the Electron main process and expose a narrow API to the renderer.
- Test input, clipboard operations, terminal resizing, and reconnection on early Linux and macOS builds. Electron provides the same interface engine across all three operating systems. Consider Tauri and system WebViews if download size becomes a higher priority.
- Publish public English and Russian pages at `ssh-workspace.ag38.ru` that describe local storage, terminals, and SFTP. Link to releases, source code, and the license. List tested operating system versions and architectures next to the downloads. Add a sitemap and check indexing after launch.
- If measurements show that xterm.js limits performance, compare it with `libghostty-vt`. It is a cross-platform terminal emulation core that would require integration for rendering, selection, and clipboard operations.

## References

- [VS Code terminal copy and paste](https://code.visualstudio.com/docs/terminal/basics#_copy-paste) shows an xterm.js terminal. To try PuTTY-style behavior, enable `terminal.integrated.copyOnSelection` and set `terminal.integrated.rightClickBehavior` to `paste`. [Tabby](https://github.com/Eugeny/tabby) is an example of a dedicated xterm.js SSH client.
- [xterm.js API](https://xtermjs.org/docs/api/terminal/classes/terminal/) · [Flow control](https://xtermjs.org/docs/guides/flowcontrol/) · [node-pty](https://github.com/microsoft/node-pty) · [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [PhpStorm terminal](https://www.jetbrains.com/help/phpstorm/terminal-emulator.html) · [libghostty-vt](https://libghostty.org/vt/index.html) · [tmux](https://github.com/tmux/tmux/wiki/Getting-Started)

