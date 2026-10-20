# Vim + LazyVim usage

Reference for when I forget how something works. Setup, plugins and the AI part are in [README.md](README.md). `vim` is an alias for `nvim` (see [zsh](../zsh/README.md)). Leader key is `Space`; line numbers are hybrid (relative).

Part 1 is plain Vim, which also works on servers, in exams and in `less`, `man` and [k9s](../../kubernetes/k9s.md). Part 2 is what LazyVim adds on top.

**Finding a key you forgot:** press `Space` and wait (which-key shows every group), `<leader>sk` searches all keymaps by description, `<leader>?` shows the keys of the current buffer, `<leader>sh` searches `:help`.

# Part 1: Vim

## Modes

| Key | Mode |
|---|---|
| `Esc` / `Ctrl+[` | back to **normal** mode (everything else starts here) |
| `i` / `a` | insert before / after the cursor |
| `I` / `A` | insert at start / end of the line |
| `o` / `O` | new line below / above and insert |
| `v` / `V` / `Ctrl+v` | visual: characters / lines / block |
| `:` | command line |

## Save, quit

```vim
:w            " save                :w name   save as
:q            " quit                :q!       quit, discard changes
:wq  or  :x   " save and quit       ZZ        same, in normal mode
:wa  :qa  :wqa   " all files / all buffers
:e!           " reload file from disk, discard changes
```

LazyVim: `Ctrl+s` saves in any mode, `<leader>qq` quits everything.

## Movement

```text
h j k l          left / down / up / right
w  b  e          next word / previous word / end of word
0  ^  $          start of line / first non-blank / end of line
gg  G            top / bottom of file
42G  or  :42     go to line 42
%                jump to matching bracket
{  }             previous / next paragraph (blank line)
Ctrl+d  Ctrl+u   half page down / up
Ctrl+f  Ctrl+b   full page down / up
zz  zt  zb       scroll so cursor line is centered / top / bottom
Ctrl+o  Ctrl+i   jump back / forward in the jump list
```

`f<char>` jumps to the next `<char>` on the line (`;` repeats, `,` reverses), `t<char>` stops just before it.

## Edit

```text
x  X             delete char under / before cursor
dd  D            delete line / delete to end of line
dw  d$  d0       delete word / to end of line / to start
cc  C  cw        change line / to end of line / word (delete + insert)
yy  yw           yank (copy) line / word
p  P             paste after / before
u  Ctrl+r        undo / redo
.                repeat the last change
r<char>          replace one character
J                join line below onto this one
>>  <<           indent / unindent line
~                toggle case
```

Operators combine with motions and counts: `d3w` deletes 3 words, `y2j` copies this + 2 lines, `c$` changes to end of line.

Text objects: `ciw` change word, `ci"` change inside quotes, `di(` delete inside parens, `dap` delete paragraph (`i` = inside, `a` = around).

Clipboard: in LazyVim `y` and `p` use the macOS clipboard directly (`clipboard=unnamedplus`). In a plain Vim (server, exam) it's `"+y` / `"+p`.

## Search and replace

```text
/text   ?text    search forward / backward
n  N             next / previous hit
*  #             search for the word under the cursor, forward / backward
:noh             clear the highlight (LazyVim: Esc does it)
```

```vim
:s/old/new/            " first match on this line
:s/old/new/g           " all matches on this line
:%s/old/new/g          " whole file
:%s/old/new/gc         " ... asking for confirmation on each
:5,12s/old/new/g       " lines 5 to 12
```

## Multiple files

Vim keeps every opened file in a **buffer**; list and switch between them.

```vim
:e path/to/file       " open a file (Tab completes), e.g. :e %:h/other.yaml for same directory
:ls                   " list buffers (numbers + names, % = current, + = modified)
:b 3   :b name        " switch to buffer 3 / by (part of) the name
:bn  :bp              " next / previous buffer
Ctrl+^                " toggle between current and previous file
:bd                   " close the buffer (file)
```

Open several at once: `nvim a.yaml b.yaml`, or `nvim -p a b` for tabs. `nvim -O a.yaml ../other/b.yaml` opens them side by side (`-O` vertical, `-o` horizontal).

Copy a manifest into a new file: in the old file `V` `G` `y` (select all lines, yank), switch to the other split (`Ctrl+w h` / `Ctrl+w l`), `p`.

Read command output in vim: `helm show values repo/chart | vim -` (`-` = stdin), then `:vsp my-values.yaml` to write your own file next to it.

### Splits and tabs

```vim
:sp file   :vsp file   " horizontal / vertical split (without a file: same buffer)
Ctrl+w h/j/k/l         " move between splits (LazyVim: just Ctrl+h/j/k/l)
Ctrl+w w               " cycle through splits
Ctrl+w =               " equalize sizes
Ctrl+w c   Ctrl+w o    " close this split / close all others
:tabnew file           " new tab; gt / gT next / previous, 3gt tab 3
```

A tab is a layout of splits, not a file; for switching files, buffers are the lighter tool.

## Registers, marks, macros

```text
"ayy  "ap        yank into / paste from register a
:reg             show registers (LazyVim: <leader>s")
ma   'a          set mark a / jump to it (backtick-a: exact position)
qa ... q         record a macro into register a, stop with q
@a   @@          play it / repeat the last one
```

## Handy commands

```vim
:help <topic>      " e.g. :help registers, Ctrl+] follows a link, Ctrl+o goes back
:set paste         " paste without auto-indent (YAML staircase fix), :set nopaste off
:set number!       " toggle line numbers; :set relativenumber!
:set wrap!         " toggle line wrapping
:!command          " run a shell command, e.g. :!ls
:r !command        " insert the output of a command
:%!jq .            " filter the whole buffer through a command
```

> For the Kubernetes exams keep vim minimal: there is no config of yours, so remember `:set paste` instead of relying on a vimrc.

# Part 2: LazyVim

## How LazyVim is organized

- **Leader groups** (press `Space`): `f` files, `s` search, `c` code, `g` git, `b` buffers, `w` windows, `u` UI toggles, `x` diagnostics/lists, `d` debug, `t` test, `q` sessions, `a` AI/Claude, `o` OpenCode, `R` REST.
- **Root dir vs cwd**: most pickers have two versions. Lowercase works in the project root (found via LSP or `.git`), uppercase in the current working directory: `<leader>ff` vs `<leader>fF`, `<leader>sg` vs `<leader>sG`.
- **`[` / `]` pairs** jump to previous / next of something: `d` diagnostic, `e` error, `w` warning, `h` git hunk, `q` quickfix, `t` TODO, `f` function, `c` class, `a` argument, `]]` / `[[` next / previous reference to the word under the cursor.
- **`:Lazy`** (`<leader>l`) plugins, **`:Mason`** (`<leader>cm`) tools, **`:LazyExtras`** optional features, **`<leader>L`** changelog.

## Files and the explorer

| Key | Action |
|---|---|
| `<leader><space>` / `<leader>ff` | find files (root), `<leader>fF` in cwd |
| `<leader>fr` | recent files; `<leader>fg` git files only |
| `<leader>,` / `<leader>fb` | open buffers |
| `<leader>fc` | find a Neovim config file |
| `<leader>e` / `<leader>E` | explorer (root / cwd), toggles |
| `<leader>fn` | new file |

Inside **any picker**: type to filter, `Enter` opens, `Ctrl+v` / `Ctrl+s` open in vertical / horizontal split, `Tab` selects several, `Ctrl+q` sends results to the quickfix list, `Alt+h` / `Alt+i` show hidden / git-ignored files, `Alt+p` toggles the preview, `Esc` closes (insert → normal → close).

Inside the **explorer**: `l`/`Enter` open, `h` close folder, `Backspace` go up, `a` add (end with `/` for a folder), `r` rename, `d` delete, `c` copy, `m` move, `y` then `p` in another folder copies files, `o` open with macOS, `H` hidden files, `I` ignored files, `]g` / `[g` next / previous changed file, `<leader>/` grep in that folder, `<leader>as` add the file to Claude. The mouse works too.

## Buffers, windows, layout

| Key | Action |
|---|---|
| `H` / `L` | previous / next buffer (the tabs at the top are buffers) |
| `<leader>bb` or `` <leader>` `` | toggle with the last buffer |
| `<leader>bd` / `<leader>bo` | close buffer / close all others |
| `<leader>bp` + `<leader>bP` | pin, then close everything not pinned |
| `<leader>-` / `<leader>\|` | split below / right |
| `Ctrl+h/j/k/l` | move between windows (also out of a terminal) |
| `Ctrl+arrows` | resize the window |
| `<leader>wd` / `<leader>wm` | close window / zoom (maximize) it |
| `<leader>uz` | zen mode (only the code) |

## Moving fast

- `s` + 2 chars: **flash** labels every match on screen, type the label to jump. `S` labels the treesitter nodes around the cursor (expression, block, function); after an operator it acts on the chosen node: `dS` + label deletes it, `yS` copies it.
- `]f` / `[f` next / previous function, `]c` class, `]a` argument; `]]` / `[[` next / previous use of the word under the cursor.
- `Ctrl+Space` starts treesitter selection and grows it per press (expression → statement → block → function); `Backspace` shrinks.
- Text objects (mini.ai) beyond Vim's: `af`/`if` function, `ac`/`ic` class, `ao`/`io` block/loop/if, `aa`/`ia` argument, `au`/`iu` function call, `ag`/`ig` whole buffer, `at`/`it` HTML tag, `in`/`an` next object, `il`/`al` last. Example: `cif` rewrites a function body, `daa` deletes an argument with its comma, `yag` copies the whole file.
- `gcc` comments a line, `gc` + motion comments a range (`gcip` a paragraph, `gcaf` a function).
- `Alt+j` / `Alt+k` move the line (or selection) down / up.

## Search and replace across files

| Key | Action |
|---|---|
| `<leader>/` or `<leader>sg` | live grep in the project (`<leader>sG` in cwd) |
| `<leader>sw` | grep the word under the cursor (or the selection) |
| `<leader>sb` | lines in this buffer |
| `<leader>sr` | **search and replace** in the project (grug-far): type search, replace and optional file filter (e.g. `*.yaml`), review the diff preview, `<localleader>r` (`\r`) replaces all |
| `<leader>sR` | resume the last picker with its query |
| `<leader>ss` / `<leader>sS` | symbols in this file / whole workspace (LSP) |
| `<leader>sd` / `<leader>sD` | diagnostics (workspace / buffer) |
| `<leader>st` | TODO/FIXME comments |
| `<leader>su` | undo history as a tree (get back what plain undo lost) |
| `<leader>s"` / `<leader>sm` / `<leader>sj` | registers / marks / jumps |

The query is a ripgrep regex; `Ctrl+g` switches between live grep and fuzzy filtering of the results found so far.

## Code: LSP, completion, formatting

| Key | Action |
|---|---|
| `gd` / `gr` / `gI` / `gy` / `gD` | definition / references / implementation / type definition / declaration |
| `K` / `gK` | hover docs / signature help (`Ctrl+k` in insert mode) |
| `<leader>ca` | code action (quick fixes, imports, "fill struct" in Go) |
| `<leader>cr` | rename symbol everywhere; `<leader>cR` rename the file (imports follow) |
| `<leader>cf` | format (also runs on save; `<leader>uf` / `<leader>uF` turn that off globally / per buffer) |
| `<leader>cd` | diagnostics of this line in a float |
| `<leader>xx` / `<leader>xX` | all diagnostics / this buffer's in Trouble (a list you can jump through) |
| `<leader>cs` | symbol outline (Trouble) |
| `<leader>cl` | LSP info: which servers are attached |
| `<leader>cv` | (Python) pick the virtualenv |

Completion (blink.cmp) pops up while typing: `Ctrl+n` / `Ctrl+p` or arrows to move, `Enter` or `Ctrl+y` accepts, `Ctrl+e` closes, `Ctrl+Space` opens it manually, `Tab` / `Shift+Tab` jump through snippet fields. AI ghost text is separate (grey text after the cursor): `Ctrl+l` accepts it, `Ctrl+j` one line, `Ctrl+]` next / ask now.

## Git beyond `git add` and `git commit`

### In the buffer (gitsigns)

The left column marks added, changed and deleted lines. A **hunk** is one block of changes.

| Key | Action |
|---|---|
| `]h` / `[h` | next / previous hunk (`]H` / `[H` last / first) |
| `<leader>ghp` | preview the hunk inline (what was there before) |
| `<leader>ghs` / `<leader>ghr` | stage / reset the hunk (in visual mode: only the selected lines) |
| `<leader>ghu` | undo the last stage |
| `<leader>ghS` / `<leader>ghR` | stage / reset the whole file |
| `<leader>ghb` | blame this line with the full commit message; `<leader>ghB` blame the whole buffer |
| `<leader>ghd` / `<leader>ghD` | side-by-side diff against the index / against the previous commit (`~`) |
| `ih` | text object: `vih` selects the hunk, `dih` deletes it |

Partial commits without leaving the file: select just the lines that belong together, `<leader>ghs`, repeat, then commit. Everything else stays unstaged.

### History and pickers

| Key | Action |
|---|---|
| `<leader>gs` | git status as a picker with diff preview |
| `<leader>gd` / `<leader>gD` | all changed hunks / diff against `origin` (what my branch adds) |
| `<leader>gl` / `<leader>gL` | log (root / cwd) |
| `<leader>gf` | history of the current file |
| `<leader>gb` | blame of this line (commit in a float) |
| `<leader>gS` | stashes |
| `<leader>gB` / `<leader>gY` | open the file (or selected lines) on GitHub / copy that URL |
| `<leader>gp` / `<leader>gP` | GitHub pull requests (open / all), via `gh` |
| `<leader>gi` / `<leader>gI` | GitHub issues (open / all) |

### lazygit (`<leader>gg`)

A full git UI in a float. Five panels on the left: 1 status, 2 files, 3 branches, 4 commits, 5 stash; switch with the number, `Tab`/`h`/`l` or the mouse. `?` lists every key of the current panel, `z` / `Z` undo / redo almost anything (it uses the reflog), `q` closes. `e` on a file opens it in the Neovim around lazygit (`nvim-remote`, set up by LazyVim).

| Task | Keys (lazygit 0.66) |
|---|---|
| Stage file / all, commit | `Space` / `a`, then `c` (message) or `C` (in the editor) |
| Stage single lines or hunks | `Enter` on the file, then `Space` per line, `v` for a range, `a` toggles hunk mode, `Tab` switches staged/unstaged side, `Esc` back |
| Amend the last commit | stage, then `A` (files panel) |
| Push / pull / fetch | `P` / `p` / `f` |
| New branch, checkout, previous branch | branches panel: `n`, `Space`, `-` |
| Rebase onto / merge into current | on the other branch: `r` / `M` |
| Fixup an older commit | stage the fix, in commits select the target, `F` (fixup commit), later `S` applies all fixups (autosquash) |
| Clean up history (interactive rebase) | commits panel: `s` squash into the one below, `f` fixup, `r` reword, `d` drop, `Ctrl+j` / `Ctrl+k` move, `e` stop to edit; `m` continue / abort |
| Cherry-pick | `C` on commits (also from another branch), go to the target branch, `V` pastes |
| Revert / reset | `t` revert; `g` reset menu (soft / mixed / hard) |
| Stash | files: `s` stash all, `S` options; stash panel: `Space` apply, `g` pop, `d` drop |
| Merge conflicts | `Enter` on the conflicted file, `h`/`l` previous / next conflict, `j`/`k` move between the two sides, `Space` keeps the selected side, `b` keeps both, `z` undo, `e` edit by hand; `m` continues (or aborts) the merge/rebase |
| Open a pull request | branches: `o` (create PR), `G` opens the existing one |
| Copy a commit hash | `Ctrl+o` |

Recipe, review before commit: `<leader>gd` (or `]h` through the file) to read every hunk → stage what is ready with `<leader>ghs` → `<leader>gg`, `c` → `P`.

Recipe, conflict after `git pull --rebase`: `<leader>gg`, `Enter` on each conflicted file (marked `UU`), pick the sides, `Esc`, `m` → continue. If it gets messy: `m` → abort, the branch is back where it was.

## Terminal

| Key | Action |
|---|---|
| `Ctrl+/` | toggle a terminal at the bottom (project root); `<leader>fT` in cwd |
| `Esc Esc` | (inside the terminal) back to normal mode, to scroll or copy; `i` to type again |
| `Ctrl+h/j/k/l` | leave the terminal to another window |
| `Ctrl+\` `Ctrl+n` | (inside the terminal) back to normal mode, always works |
| `Ctrl+q` | (inside the terminal) hide it, cursor back to the code window; `q` does the same in normal mode |

Good for `go test`, `kubectl`, k9s. Long-running things are better in a separate cmux pane. The Claude Code and OpenCode splits work the same way: see [README](README.md#moving-between-the-code-and-the-agent-split).

## Sessions

LazyVim saves the open files per directory when quitting. `<leader>qs` restores the session of this folder, `<leader>ql` the last one, `<leader>qS` picks one, `<leader>qd` skips saving this time. The dashboard on `nvim` without a file offers the same (`s`).

## Debug and test

| Key | Action |
|---|---|
| `<leader>db` / `<leader>dB` | breakpoint / conditional breakpoint |
| `<leader>dc` | start / continue (asks for the config, e.g. Go "Debug test") |
| `<leader>di` / `<leader>dO` / `<leader>do` | step into / over / out |
| `<leader>dC` / `<leader>dt` | run to cursor / terminate |
| `<leader>du` / `<leader>de` | debugger UI / evaluate the expression under the cursor |
| `<leader>tr` / `<leader>tt` / `<leader>tT` | run nearest test / file / all test files |
| `<leader>td` | debug the nearest test (breakpoints work) |
| `<leader>ts` / `<leader>to` / `<leader>tw` | test summary tree / output / watch (rerun on save) |

## REST requests (kulala)

Write requests in a `.http` file (`GET https://host/path`, headers below, a blank line, then the body; `###` separates requests). `<leader>Rs` sends the one under the cursor, `<leader>Rt` toggles headers/body, `<leader>Rr` replays the last, `<leader>RC` pastes a `curl` command as a request, `<leader>Rc` copies one as `curl`, `<leader>Rb` opens a scratchpad.

## AI

Full details and model notes in [README.md](README.md#ai).

```text
Ctrl+l  Ctrl+j  Ctrl+]  Ctrl+e   ghost text: accept / accept line / next or ask now / dismiss  (insert mode)
<leader>am   <leader>ap           prediction model / toggle prediction in this buffer
<leader>ac   <leader>as  <leader>ab   Claude Code: toggle / send selection / add file
<leader>aa   <leader>ad           accept / deny Claude's diff
<leader>oo   <leader>oa  <leader>os   OpenCode: toggle / ask about this / prompts menu
<leader>oe   <leader>or  <leader>of   OpenCode: explain / review this / fix diagnostics
```

Usage of the prediction model shows up in `~/.gateway-cost/dashboard.html` next to OpenCode and Claude Code (tool `nvim`).

## UI toggles (`<leader>u`)

`<leader>uC` colorscheme picker with live preview, `<leader>uw` wrap, `<leader>ul` / `<leader>uL` line numbers / relative numbers, `<leader>ud` diagnostics, `<leader>uh` inlay hints (e.g. Go parameter names), `<leader>ug` indent guides, `<leader>us` spelling, `<leader>uT` treesitter highlight, `<leader>ui` / `<leader>uI` what highlight group is under the cursor / the syntax tree, `<leader>un` dismiss notifications (`<leader>n` shows their history).

## Recipes

- **Helm values with the chart's defaults next to it:** `<leader>ft`, run `helm show values repo/chart > /tmp/defaults.yaml`, back with `Ctrl+k`, then `:vsp /tmp/defaults.yaml`; `Ctrl+h/l` between the two, `<leader>sw` on a key to find where the templates use it.
- **Go: why does this test fail?** cursor in the test, `<leader>td` (debug nearest), `<leader>db` on suspicious lines first; `<leader>de` on variables.
- **Rename across the project:** `<leader>cr` when an LSP knows the symbol; otherwise `<leader>sr`, a regex like `old_name\b`, check the preview, `\r`.
- **Kubernetes manifest from memory:** new `deploy/app.yaml`, type `apiVersion:`, completion offers the fields of the schema; `K` on a field explains it.
- **Repeat an edit on many lines:** `qa`, do it once on one line ending with `j0`, `q`, then `50@a`; or select lines and `:norm @a`.

## Plugin and maintenance commands

```vim
:Lazy              " plugins: U update, R restore lockfile versions, X clean, P profile startup
:Mason             " LSP servers, formatters, linters: i install, X uninstall, U update all
:LazyExtras        " optional features (x toggles); I keep the list in lua/config/lazy.lua
:LazyHealth        " :checkhealth for LazyVim and its plugins
:LspRestart        " restart the language servers of this buffer
:ConformInfo       " which formatter runs for this file and why
:Inspect           " highlight groups under the cursor
```
