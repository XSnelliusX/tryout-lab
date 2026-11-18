import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { exec, spaces, panes, theme, run } from "herdr";

function locations() {
  const result = [], seen = new Set();
  for (const space of spaces()) {
    const tabs = new Set(space.tabs.map(t => t.id));
    const folders = panes().filter(p => tabs.has(p.tab) && p.cwd).map(p => p.cwd);
    if (!folders.length && space.folder) folders.push(space.folder);
    for (const cwd of folders) {
      const key = JSON.stringify([space.machine, cwd]);
      if (!seen.has(key)) { seen.add(key); result.push({ cwd, on: space.machine }); }
    }
  }
  return result;
}

export function githubUrl(remote) {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}` : null;
}

async function checked(command, args, options) {
  const r = await exec(command, args, options);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${command} failed`).trim());
  return r.stdout;
}

export default class GitHub extends View {
  init(_props, cx) {
    this.authored = []; this.reviews = []; this.repos = []; this.errors = {};
    this.page = "prs"; this.prLoading = false; this.branchLoading = false;
    this.refreshPRs(cx); this.refreshBranches(cx);
    cx.timer.every(120000, cx => this.refreshPRs(cx));
    cx.timer.every(30000, cx => this.refreshBranches(cx));
  }

  refreshPRs(cx) {
    if (this.prLoading) return;
    this.prLoading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        this.login = (await checked("gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"])).trim();
        for (const [key, filter] of [["authored", "--author"], ["reviews", "--review-requested"]]) {
          try {
            const text = await checked("gh", ["search", "prs", filter, "@me", "--state", "open", "--sort", "updated", "--limit", "50", "--json", "number,title,url,repository,isDraft,updatedAt"]);
            this[key] = JSON.parse(text); delete this.errors[key];
          } catch (e) { this.errors[key] = String(e); }
        }
        this.prUpdated = new Date().toLocaleTimeString(); delete this.errors.auth;
      } catch (e) { this.errors.auth = `GitHub unavailable. Run gh auth status. ${e}`; }
      finally { this.prLoading = false; cx.notify(); }
    });
  }

  refreshBranches(cx) {
    if (this.branchLoading) return;
    const places = locations(); this.context = JSON.stringify(places); this.branchLoading = true;
    cx.spawn(async cx => {
      const repos = [], seen = new Set();
      try {
        for (const place of places) {
          try {
            const root = await exec("git", ["rev-parse", "--show-toplevel"], place);
            if (root.code !== 0) continue;
            const cwd = root.stdout.trim(), key = JSON.stringify([place.on, cwd]);
            if (seen.has(key)) continue;
            seen.add(key);
            const options = { cwd, on: place.on };
            const text = await checked("git", ["for-each-ref", "--sort=-committerdate", "--format=%(HEAD)%09%(refname:short)%09%(upstream:track)", "refs/heads", "refs/remotes"], options);
            const remote = await exec("git", ["remote", "get-url", "origin"], options);
            const all = text.trimEnd().split("\n").filter(Boolean).map(line => {
              const [head, name, tracking] = line.split("\t");
              return { current: head === "*", name, tracking, remote: name.startsWith("origin/") };
            }).filter(b => b.name && !b.name.endsWith("/HEAD"));
            repos.push({ key, cwd, on: place.on, name: cwd.split("/").pop(), url: remote.code === 0 ? githubUrl(remote.stdout) : null, branches: all.slice(0, 60), limited: all.length > 60 });
          } catch (e) { repos.push({ key: JSON.stringify(place), name: place.cwd, branches: [], error: String(e) }); }
        }
        if (JSON.stringify(locations()) === this.context) this.repos = repos;
      } finally { this.branchLoading = false; cx.notify(); }
    });
  }

  dashboard() {
    run("layout.select", { stack: "panel-body", child: "usage" });
    run("layout.show", { id: "panel" });
  }

  prSection(title, key, t) {
    return v_flex().gap(6).child(div().text_size(11).font_semibold().text_color(t.muted).child(`${title} · ${this[key].length}${this[key].length === 50 ? "+" : ""}`))
      .when(Boolean(this.errors[key]), e => e.child(div().text_size(11).text_color(t.blocked).child(`Refresh failed; previous results retained. ${this.errors[key]}`)))
      .children(this[key].map(pr => v_flex().id(`${key}-${pr.url}`).flex_none().p(10).gap(4).rounded(8).bg(t.surface).cursor_pointer().hover(s => s.bg(t.hover)).tooltip(pr.title).on_click((_e, cx) => cx.open_url(pr.url))
        .child(div().text_size(10).text_color(t.accent).truncate().child(`${pr.repository.nameWithOwner} #${pr.number}`))
        .child(div().text_size(12).child(pr.title))
        .child(div().text_size(10).text_color(t.dim).child(pr.isDraft ? "Draft" : "Open pull request"))))
      .when(!this[key].length, e => e.child(div().text_size(12).text_color(t.dim).child(this.prLoading ? "Loading…" : this.errors.auth || this.errors[key] ? "Results unavailable" : "Nothing pending")));
  }

  render(cx) {
    if (JSON.stringify(locations()) !== this.context) this.refreshBranches(cx);
    const t = theme();
    const button = (id, label, action) => div().id(id).px(9).py(6).rounded(6).text_size(11).cursor_pointer().hover(s => s.bg(t.hover)).on_click(action).child(label);
    return v_flex().id("github-root").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_none().h(44).px(12).items_center().justify_between().child(div().font_semibold().child("GitHub"))
        .child(button("github-refresh", this.prLoading || this.branchLoading ? "Loading…" : "Refresh", (_e, cx) => { this.refreshPRs(cx); this.refreshBranches(cx); })))
      .child(div().px(12).pb(8).text_size(10).text_color(t.dim).truncate().child(this.login ? `@${this.login} · github.com` : "Using your GitHub CLI account"))
      .child(h_flex().flex_none().px(8).pb(8).gap(4).children([["prs", "Pull requests"], ["branches", "Branches"]].map(([page, title]) => button(`github-${page}`, title, (_e, cx) => { this.page = page; cx.notify(); }).when(this.page === page, e => e.bg(t.selected).text_color(t.accent)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("github-scroll").absolute().inset_0().overflow_y_scroll().p(12).gap(16)
          .when(Boolean(this.errors.auth), e => e.child(div().text_size(11).text_color(t.blocked).child(this.errors.auth)))
          .when(this.page === "prs", e => e.child(this.prSection("Your open PRs", "authored", t)).child(this.prSection("Review requested", "reviews", t)))
          .when(this.page === "branches", e => e
            .child(div().text_size(11).text_color(t.dim).child("Local and cached remote branches in open workspace repositories. No fetch or checkout."))
            .when(!this.repos.length, el => el.child(div().text_color(t.muted).child(this.branchLoading ? "Looking for repositories…" : "Open a terminal inside a Git repository to see its branches.")))
            .children(this.repos.map(repo => v_flex().gap(5).child(div().font_semibold().child(`${repo.name}${repo.on ? ` · ${repo.on}` : ""}`))
              .when(Boolean(repo.error), el => el.child(div().text_size(11).text_color(t.blocked).child(repo.error)))
              .children(repo.branches.map(b => v_flex().id(`branch-${repo.key}-${b.name}`).p(7).rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
                .tooltip(repo.url ? "Open branch on GitHub (unpublished branches may not exist there)" : "Copy branch name")
                .on_click((_e, cx) => { const name = b.remote ? b.name.slice(7) : b.name; if (repo.url) cx.open_url(`${repo.url}/tree/${encodeURIComponent(name)}`); else cx.write_to_clipboard(b.name); })
                .child(div().truncate().text_size(12).text_color(b.current ? t.accent : t.foreground).child(`${b.current ? "● " : ""}${b.name}`))
                .when(Boolean(b.tracking), el => el.child(div().text_size(10).text_color(t.dim).child(b.tracking)))))
              .when(repo.limited, el => el.child(div().text_size(10).text_color(t.dim).child("Showing 60 most recently updated branches")))))))
        .child(Scrollbar.vertical("github-scroll").absolute().inset_0()))
      .child(v_flex().flex_none().p(10).gap(5).border_t(1).border_color(t.border)
        .child(button("usage-open", "Usage dashboard →", () => this.dashboard()).bg(t.surface))
        .child(div().text_size(10).text_color(t.dim).child(`PRs refresh every 2 min${this.prUpdated ? ` · ${this.prUpdated}` : ""}`)));
  }
}
