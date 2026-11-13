// Setup tab: recording & microphone volume controls, spoken language, meeting topic context, and custom glossary.
import { el, icon } from "/glass.js";
import { mount as mountAudio } from "/panel-audio.js";
import { mount as mountContext } from "/panel-context.js";

export function mount(container) {
  const wrap = el("div", { class: "pn" });
  const audioHost = el("div", { class: "pn-stack" });
  const contextHost = el("div", { class: "pn-stack" });

  const contextDetails = el("details", { class: "glass-disclosure" },
    el("summary", null, el("span", null, "Meeting topic & custom glossary"), icon("chevron-right")),
    el("div", { class: "glass-disclosure-body" }, contextHost));

  wrap.append(audioHost, contextDetails);
  container.replaceChildren(wrap);

  mountAudio(audioHost);
  const unmountContext = mountContext(contextHost);
  return () => unmountContext?.();
}
